// Brancard server, hosted by pihost (compose.yaml at the repo root). Stores nothing about anyone.
//   GET  /                         download page (the "link in bio"), page.html
//   GET  /download                 latest APK
//   GET  /tracts                   A4 sheet of cards to print, cut and hand around: the browser builds it from one
//                                  card (card.svg, from promo/make_flyer.py --card-svg) and prints it or saves a PDF
//   GET  /confidentialite          privacy policy (linked from the app and the App Store listing)
//   GET  /count, POST /install     install counter: a total, nothing else (the app posts once, on first launch)
//   GET  /updates/manifest         expo-updates protocol 1: the signed manifest for the phone's runtime, or 204
//   GET  /updates/assets/:sha256   update files
//   PUT  /updates/assets/:sha256, PUT /updates, PUT /apk   uploads, `Authorization: Bearer $DEPLOY_TOKEN`
// Manifests are signed on the developer's machine (scripts/deploy.ts); this server only relays them, so taking it
// over is not enough to push code to phones.
// Env: PORT=8787, DATA=./data, DEPLOY_TOKEN.  `server --health` probes /count.
//
// RAM: a few threads on blocking I/O, files streamed from and to disk (uploads are hashed while they are
// written, never held in memory), the pages and the card compiled into the binary.
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const PAGE: &str = include_str!("../page.html");
const TRACTS: &str = include_str!("../tracts.html");
const PRIVACY: &str = include_str!("../privacy.html");
const CARD: &str = include_str!("../card.svg");
const BTN_ON: &str = r#"<a class="b android" href="/download"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.66-.38l-1.86 3.22a11.5 11.5 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg> TÉLÉCHARGER POUR ANDROID</a"#;
const BTN_OFF: &str = r#"<div class="b off" aria-disabled="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.66-.38l-1.86 3.22a11.5 11.5 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg> ANDROID <small>bientôt</small></div"#;
const MAX_UPDATE_JSON: u64 = 1 << 20; // a signed manifest is a few KB
const MAX_UPLOAD: u64 = 200 << 20;
const THREADS: usize = 16; // slow phones downloading the APK hold a thread each; 256 KB stacks, so cheap

struct App {
    data: PathBuf,
    token: String,
    count: Mutex<u64>,
}

type Res = Response<Box<dyn Read + Send>>;

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("ascii header")
}

fn respond(status: u16, body: impl Into<Vec<u8>>, headers: &[(&str, &str)]) -> Res {
    let body = body.into();
    let len = body.len();
    let mut r = Response::new(StatusCode(status), vec![], Box::new(std::io::Cursor::new(body)) as Box<dyn Read + Send>, Some(len), None);
    for (k, v) in headers {
        r.add_header(header(k, v));
    }
    r
}

fn json(status: u16, v: serde_json::Value) -> Res {
    respond(status, v.to_string(), &[("content-type", "application/json"), ("cache-control", "no-store")])
}

fn file(path: &Path, headers: &[(&str, &str)]) -> Option<Res> {
    let f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len() as usize;
    let mut r = Response::new(StatusCode(200), vec![], Box::new(f) as Box<dyn Read + Send>, Some(len), None);
    for (k, v) in headers {
        r.add_header(header(k, v));
    }
    Some(r)
}

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_runtime(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

fn is_signature(s: &str) -> bool {
    (16..=1024).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

// Constant time, so the token can't be guessed byte by byte from response times.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn get_header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

impl App {
    fn authorized(&self, req: &Request) -> bool {
        let want = format!("Bearer {}", self.token);
        self.token.len() >= 16 && same(get_header(req, "authorization").unwrap_or("").as_bytes(), want.as_bytes())
    }

    fn save_count(&self, n: u64) {
        let p = self.data.join("count");
        let _ = fs::write(p.with_extension("tmp"), n.to_string()).and_then(|_| fs::rename(p.with_extension("tmp"), &p));
    }

    /// Streams the body to `dest` (through a temp file, so readers never see half a file) while hashing it.
    fn receive(&self, req: &mut Request, dest: &Path, want_sha: Option<&str>) -> Result<(), Res> {
        if req.body_length().map_or(false, |n| n as u64 > MAX_UPLOAD) {
            return Err(json(413, serde_json::json!({ "error": "too large" })));
        }
        let tmp = dest.with_extension("tmp");
        let mut out = File::create(&tmp).map_err(|_| json(500, serde_json::json!({ "error": "disk" })))?;
        let mut hash = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut total = 0u64;
        let reader = req.as_reader();
        loop {
            let n = reader.read(&mut buf).map_err(|_| json(400, serde_json::json!({ "error": "read" })))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_UPLOAD {
                let _ = fs::remove_file(&tmp);
                return Err(json(413, serde_json::json!({ "error": "too large" })));
            }
            hash.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|_| json(500, serde_json::json!({ "error": "disk" })))?;
        }
        drop(out);
        if let Some(want) = want_sha {
            let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
            if got != want {
                let _ = fs::remove_file(&tmp);
                return Err(json(422, serde_json::json!({ "error": "hash mismatch" })));
            }
        }
        fs::rename(&tmp, dest).map_err(|_| json(500, serde_json::json!({ "error": "disk" })))
    }

    fn handle(&self, mut req: Request) {
        let path = req.url().split('?').next().unwrap_or("").to_string();
        let method = req.method().clone();
        let apk = self.data.join("echo.apk");
        let asset = path.strip_prefix("/updates/assets/").filter(|h| is_sha(h)).map(str::to_string);

        let res: Res = match (&method, path.as_str()) {
            (Method::Get, "/") => {
                let n = *self.count.lock().unwrap();
                let page = PAGE.replace("{{DOWNLOAD}}", if apk.exists() { BTN_ON } else { BTN_OFF }).replace("{{COUNT}}", &n.to_string());
                respond(200, page, &[("content-type", "text/html; charset=utf-8")])
            }
            (Method::Get, "/download") => file(&apk, &[
                ("content-type", "application/vnd.android.package-archive"),
                ("content-disposition", "attachment; filename=\"Brancard.apk\""),
            ])
            .unwrap_or_else(|| json(404, serde_json::json!({ "error": "no apk yet" }))),
            (Method::Get, "/confidentialite") => respond(200, PRIVACY, &[("content-type", "text/html; charset=utf-8")]),
            (Method::Get, "/tracts") => respond(200, tracts(), &[("content-type", "text/html; charset=utf-8")]),
            (Method::Get, "/tracts.pdf") => respond(301, Vec::new(), &[("location", "/tracts")]), // links shared before
            (Method::Get, "/count") => json(200, serde_json::json!({ "count": *self.count.lock().unwrap() })),
            (Method::Post, "/install") => {
                // No IP kept, not even in memory: the app's own "installed" flag stops double counts.
                // ponytail: anyone can inflate the total with repeated POSTs; it's a vanity number, nothing depends on it.
                let mut count = self.count.lock().unwrap();
                *count += 1;
                self.save_count(*count);
                json(200, serde_json::json!({ "count": *count }))
            }
            (Method::Get, "/updates/manifest") => {
                let runtime = get_header(&req, "expo-runtime-version").unwrap_or("").to_string();
                let platform = get_header(&req, "expo-platform").unwrap_or("android");
                let base = [("expo-protocol-version", "1"), ("expo-sfv-version", "0"), ("cache-control", "private, max-age=0")];
                let stored = ((platform == "android" || platform == "ios") && is_runtime(&runtime))
                    .then(|| fs::read_to_string(self.data.join("updates").join(format!("{runtime}.json"))).ok())
                    .flatten()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                match stored {
                    Some(u) => {
                        let sig = format!("sig=\"{}\", keyid=\"main\", alg=\"rsa-v1_5-sha256\"", u["signature"].as_str().unwrap_or(""));
                        let mut h = base.to_vec();
                        h.push(("expo-signature", &sig));
                        h.push(("content-type", "application/json"));
                        respond(200, u["manifest"].as_str().unwrap_or("").to_string(), &h)
                    }
                    None => respond(204, Vec::new(), &base),
                }
            }
            (Method::Get, _) if asset.is_some() => file(&self.data.join("assets").join(asset.as_ref().unwrap()), &[
                ("content-type", "application/octet-stream"),
                ("cache-control", "public, max-age=31536000, immutable"),
            ])
            .unwrap_or_else(|| json(404, serde_json::json!({ "error": "no such asset" }))),
            (Method::Put, p) if asset.is_some() || p == "/updates" || p == "/apk" => {
                if !self.authorized(&req) {
                    json(401, serde_json::json!({ "error": "unauthorized" }))
                } else if let Some(h) = &asset {
                    let dest = self.data.join("assets").join(h);
                    self.receive(&mut req, &dest, Some(h)).map(|_| json(200, serde_json::json!({ "ok": true }))).unwrap_or_else(|e| e)
                } else if p == "/apk" {
                    self.receive(&mut req, &apk, None).map(|_| json(200, serde_json::json!({ "ok": true }))).unwrap_or_else(|e| e)
                } else {
                    self.publish(&mut req)
                }
            }
            _ => json(404, serde_json::json!({ "error": "not found" })),
        };
        let _ = req.respond(res);
    }

    // { runtimeVersion, manifest: <signed JSON text>, signature: <base64> }; every asset must be uploaded first.
    fn publish(&self, req: &mut Request) -> Res {
        let bad = || json(422, serde_json::json!({ "error": "runtimeVersion, manifest and signature are required" }));
        let mut body = String::new();
        if req.as_reader().take(MAX_UPDATE_JSON).read_to_string(&mut body).is_err() {
            return bad();
        }
        let Ok(u) = serde_json::from_str::<serde_json::Value>(&body) else { return bad() };
        let (Some(runtime), Some(manifest), Some(sig)) = (u["runtimeVersion"].as_str(), u["manifest"].as_str(), u["signature"].as_str()) else {
            return bad();
        };
        if !is_runtime(runtime) || !is_signature(sig) {
            return bad();
        }
        let Ok(man) = serde_json::from_str::<serde_json::Value>(manifest) else { return bad() };
        if man["runtimeVersion"].as_str() != Some(runtime) {
            return json(422, serde_json::json!({ "error": "manifest runtimeVersion mismatch" }));
        }
        let mut all = vec![&man["launchAsset"]];
        all.extend(man["assets"].as_array().into_iter().flatten());
        let missing: Vec<String> = all
            .iter()
            .map(|a| a["url"].as_str().unwrap_or("").rsplit('/').next().unwrap_or("").to_string())
            .filter(|h| !is_sha(h) || !self.data.join("assets").join(h).exists())
            .collect();
        if !missing.is_empty() {
            return json(422, serde_json::json!({ "error": "missing assets", "missing": missing }));
        }
        let dest = self.data.join("updates").join(format!("{runtime}.json"));
        let stored = serde_json::json!({ "runtimeVersion": runtime, "manifest": manifest, "signature": sig }).to_string();
        if fs::write(dest.with_extension("tmp"), stored).and_then(|_| fs::rename(dest.with_extension("tmp"), &dest)).is_err() {
            return json(500, serde_json::json!({ "error": "disk" }));
        }
        json(200, serde_json::json!({ "ok": true, "id": man["id"] }))
    }
}

/// The tracts page with the card inlined (its <svg> root becomes a <symbol>), built once.
fn tracts() -> &'static str {
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PAGE.get_or_init(|| {
        let root = CARD.find("<svg").expect("card svg");
        let open_end = root + CARD[root..].find('>').expect("svg tag") + 1;
        let close = CARD.rfind("</svg>").expect("svg end");
        let tag = &CARD[root..open_end];
        let viewbox = tag.split("viewBox=\"").nth(1).and_then(|s| s.split('"').next()).expect("viewBox");
        TRACTS.replace("{{CARD_VIEWBOX}}", viewbox).replace("{{CARD}}", &CARD[open_end..close])
    })
}

fn health(port: &str) -> bool {
    let Ok(mut s) = std::net::TcpStream::connect(format!("127.0.0.1:{port}")) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.write_all(b"GET /count HTTP/1.0\r\n\r\n");
    let mut buf = [0u8; 12];
    s.read(&mut buf).map_or(false, |n| buf[..n].starts_with(b"HTTP/1.0 200") || buf[..n].starts_with(b"HTTP/1.1 200"))
}

fn main() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    let port = env("PORT", "8787");
    if std::env::args().nth(1).as_deref() == Some("--health") {
        std::process::exit(if health(&port) { 0 } else { 1 });
    }
    let data = PathBuf::from(env("DATA", "./data"));
    for d in ["assets", "updates"] {
        fs::create_dir_all(data.join(d)).expect("data dir");
    }
    let count = fs::read_to_string(data.join("count")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    let app = Arc::new(App {
        data,
        token: env("DEPLOY_TOKEN", ""),
        count: Mutex::new(count),
    });
    let server = Arc::new(Server::http(format!("0.0.0.0:{port}")).expect("bind"));
    println!("brancard server on :{}", server.server_addr().to_ip().map_or(0, |a| a.port()));
    let _ = std::io::stdout().flush();
    let workers: Vec<_> = (0..THREADS)
        .map(|_| {
            let (server, app) = (server.clone(), app.clone());
            std::thread::Builder::new()
                .stack_size(256 * 1024) // handlers are shallow; the default 2 MB per thread is wasted
                .spawn(move || {
                    for req in server.incoming_requests() {
                        app.handle(req);
                    }
                })
                .expect("thread")
        })
        .collect();
    for w in workers {
        let _ = w.join();
    }
}
