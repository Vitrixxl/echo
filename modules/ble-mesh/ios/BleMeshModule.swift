import CoreBluetooth
import ExpoModulesCore

// Same UUIDs as the Android module: that's the whole cross-platform contract. Random, so nothing on the air
// spells out what the app is.
private let SERVICE = CBUUID(string: "dcbe3a65-8595-4490-8012-38f541bb1582")
private let CHAR = CBUUID(string: "dcbe3a66-8595-4490-8012-38f541bb1582")
// Alerts broadcast by Android phones in their advertising (iOS can't broadcast data, it only listens).
private let ADV = CBUUID(string: "dcbe3a67-8595-4490-8012-38f541bb1582")
private let HEADER = 6 // msgId u16, index u16, total u16 (big endian)
// Reassembly limits (same as Android): anyone can write to the GATT server.
private let MAX_PARTS = 1024
private let MAX_PENDING_PER_PEER = 4
private let MAX_PENDING = 64
private let PENDING_S: TimeInterval = 15

/// One outgoing link: we are GATT client, the peer is GATT server. Writes are serialized.
private let MAX_LINKS = 7 // same as Android: flooding only needs the crowd connected
private let MIN_RSSI = -90
private let WRITE_TIMEOUT: TimeInterval = 15

/// One chunk to write; the last chunk of a message carries the JS promise, resolved once it is written.
/// Urgent chunks (alerts) go without write response: no round trip, and every phone of a crowd hears the
/// same alert from several neighbours, so a lost packet doesn't matter.
private struct Chunk { let data: Data; let done: Promise?; var urgent = false }

/// One outgoing link: we are GATT client, the peer is GATT server. Writes are serialized.
private final class Link {
  let peripheral: CBPeripheral
  var name: String? // the peer's random mesh name, from its advertising
  var char: CBCharacteristic?
  var queue: [Chunk] = []
  var current: Chunk?
  var writes = 0 // bumped on each write, so a stale timeout can tell the write it watched is done
  var busy = false
  init(_ p: CBPeripheral) { peripheral = p }

  /// Fails every message still waiting (link lost or write error): the JS side then resends elsewhere.
  func failAll() {
    for p in ([current?.done] + queue.map { $0.done }).compactMap({ $0 }) { p.reject("ERR_BLE_SEND", "Lien BLE perdu") }
    queue.removeAll(); current = nil; busy = false
  }
}

public class BleMeshModule: Module {
  private let q = DispatchQueue(label: "ble-mesh")
  private var central: CBCentralManager?
  private var periph: CBPeripheralManager?
  private var links: [UUID: Link] = [:]
  private var lastTry: [UUID: Date] = [:]
  private var fails: [UUID: Int] = [:] // failed connections per peripheral, for backoff
  private var seenAdv: [String: Date] = [:] // broadcast payloads already handed to JS
  fileprivate var name = ""
  private var inbox: [String: (parts: [Data?], at: Date)] = [:]
  private var msgId: UInt16 = 0
  private lazy var delegate = Delegate(self)

  public func definition() -> ModuleDefinition {
    Name("BleMesh")
    Events("onPeer", "onPeerLost", "onText")
    // name: this launch's random mesh name, advertised so a neighbour also linked over Multipeer recognises us.
    AsyncFunction("start") { (name: String) in
      self.q.async {
        self.name = name
        if self.central == nil { self.central = CBCentralManager(delegate: self.delegate, queue: self.q) }
        if self.periph == nil { self.periph = CBPeripheralManager(delegate: self.delegate, queue: self.q) }
      }
    }
    AsyncFunction("stop") { self.q.async { self.stop() } }
    // Resolves once the whole message is written: the JS outbox sends the next one only then.
    AsyncFunction("send") { (peerId: String, text: String, urgent: Bool, promise: Promise) in
      self.q.async { self.send(peerId, text, urgent, promise) }
    }
    Function("broadcast") { (_: String, _: String, _: Bool) in } // iOS can't put data in its advertising
    OnDestroy { self.q.async { self.stop() } }
  }

  private func stop() {
    central?.stopScan()
    links.values.forEach { $0.failAll(); central?.cancelPeripheralConnection($0.peripheral) }
    links.removeAll()
    periph?.stopAdvertising()
    periph?.removeAllServices()
    central = nil
    periph = nil
  }

  fileprivate func send(_ peerId: String, _ text: String, _ urgent: Bool, _ promise: Promise) {
    guard let id = UUID(uuidString: peerId), let link = links[id] else { promise.reject("ERR_BLE_PEER", "Pair BLE inconnu"); return }
    let bytes = Data(text.utf8)
    // One ATT packet per chunk, so the peer never needs prepared (long) writes.
    let size = max(20, link.peripheral.maximumWriteValueLength(for: .withoutResponse)) - HEADER
    let total = max(1, (bytes.count + size - 1) / size)
    let mid = msgId; msgId &+= 1
    for i in 0..<total {
      var chunk = Data()
      for v in [mid, UInt16(i), UInt16(total)] { chunk.append(UInt8(v >> 8)); chunk.append(UInt8(v & 0xFF)) }
      chunk.append(bytes.subdata(in: (i * size)..<min(bytes.count, (i + 1) * size)))
      link.queue.append(Chunk(data: chunk, done: i == total - 1 ? promise : nil, urgent: urgent))
    }
    pump(link)
  }

  fileprivate func pump(_ link: Link) {
    guard !link.busy, let char = link.char, !link.queue.isEmpty else { return }
    if link.queue[0].urgent {
      // Without response: no callback per write, the radio's buffer paces us (peripheralIsReady resumes).
      guard link.peripheral.canSendWriteWithoutResponse else { return }
      let c = link.queue.removeFirst()
      link.peripheral.writeValue(c.data, for: char, type: .withoutResponse)
      c.done?.resolve(nil)
      q.async { [weak self] in self?.pump(link) }
      return
    }
    link.busy = true
    let c = link.queue.removeFirst()
    link.current = c
    link.writes += 1
    let n = link.writes
    link.peripheral.writeValue(c.data, for: char, type: .withResponse)
    // A write that never completes would block this link forever: give up and drop it.
    q.asyncAfter(deadline: .now() + WRITE_TIMEOUT) { [weak self] in
      guard link.busy, link.writes == n else { return }
      link.failAll()
      self?.central?.cancelPeripheralConnection(link.peripheral)
    }
  }

  /// An alert heard in an Android phone's advertising: handed to JS once per payload.
  fileprivate func heard(_ data: Data) {
    let text = data.base64EncodedString(), now = Date()
    if let at = seenAdv[text], now.timeIntervalSince(at) < 60 { return }
    seenAdv[text] = now
    if seenAdv.count > 256 { seenAdv = seenAdv.filter { now.timeIntervalSince($0.value) < 60 } }
    sendEvent("onText", ["peerId": "adv", "text": text])
  }

  fileprivate func receive(from: String, _ data: Data) {
    guard data.count >= HEADER else { return }
    let b = [UInt8](data)
    let id = Int(b[0]) << 8 | Int(b[1]), index = Int(b[2]) << 8 | Int(b[3]), total = Int(b[4]) << 8 | Int(b[5])
    guard total > 0, index < total, total <= MAX_PARTS else { return }
    let key = "\(from):\(id)"
    let now = Date()
    inbox = inbox.filter { now.timeIntervalSince($0.value.at) < PENDING_S }
    if inbox[key] == nil {
      // Too many unfinished messages from this sender, or overall: forget the oldest.
      let mine = inbox.filter { $0.key.hasPrefix("\(from):") }.sorted { $0.value.at < $1.value.at }
      for (k, _) in mine.dropLast(MAX_PENDING_PER_PEER - 1) { inbox[k] = nil }
      while inbox.count >= MAX_PENDING, let oldest = inbox.min(by: { $0.value.at < $1.value.at }) { inbox[oldest.key] = nil }
    }
    var entry = inbox[key] ?? (parts: Array(repeating: nil, count: total), at: now)
    guard entry.parts.count == total else { inbox[key] = nil; return }
    entry.parts[index] = data.subdata(in: HEADER..<data.count)
    if entry.parts.contains(where: { $0 == nil }) { inbox[key] = entry; return }
    inbox[key] = nil
    var whole = Data()
    for part in entry.parts { whole.append(part!) }
    let text = String(decoding: whole, as: UTF8.self)
    sendEvent("onText", ["peerId": from, "text": text])
  }

  // CoreBluetooth delegates must be NSObjects; keep them out of the Module class.
  fileprivate final class Delegate: NSObject, CBCentralManagerDelegate, CBPeripheralManagerDelegate, CBPeripheralDelegate {
    weak var m: BleMeshModule?
    init(_ m: BleMeshModule) { self.m = m }

    // ---- Receiving side (GATT server) ----
    func peripheralManagerDidUpdateState(_ p: CBPeripheralManager) {
      guard p.state == .poweredOn else { return }
      let svc = CBMutableService(type: SERVICE, primary: true)
      svc.characteristics = [CBMutableCharacteristic(type: CHAR, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])]
      p.removeAllServices()
      p.add(svc)
    }

    func peripheralManager(_ p: CBPeripheralManager, didAdd service: CBService, error: Error?) {
      // The local name carries our mesh name (iOS can't advertise service data).
      if error == nil { p.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [SERVICE], CBAdvertisementDataLocalNameKey: m?.name ?? ""]) }
    }

    func peripheralManager(_ p: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
      for r in requests where r.characteristic.uuid == CHAR {
        if let v = r.value { m?.receive(from: r.central.identifier.uuidString, v) }
      }
      if let first = requests.first { p.respond(to: first, withResult: .success) }
    }

    // ---- Sending side (GATT client) ----
    func centralManagerDidUpdateState(_ c: CBCentralManager) {
      if c.state == .poweredOn {
        // Battery: no duplicate reports; a dropped link restarts the scan to rediscover the peer.
        // Duplicates on: broadcast alerts rotate in the same advertising (iOS ignores it in the background anyway).
        c.scanForPeripherals(withServices: [SERVICE, ADV], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
      }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
      if let data = (advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data])?[ADV] {
        m?.heard(data)
        return
      }
      // Backoff 10 s, 20 s… up to ~5 min for peripherals that keep failing; a cap on links; skip weak signals.
      let wait = 10.0 * Double(1 << min(m?.fails[p.identifier] ?? 0, 5))
      guard let m = m, m.links[p.identifier] == nil, m.links.count < MAX_LINKS, rssi.intValue >= MIN_RSSI || rssi.intValue == 127,
            Date().timeIntervalSince(m.lastTry[p.identifier] ?? .distantPast) > wait else { return }
      if m.lastTry.count > 2000 { m.lastTry.removeAll() }
      m.lastTry[p.identifier] = Date()
      let link = Link(p) // strong ref, CoreBluetooth drops unreferenced peripherals
      if let d = (advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data])?[SERVICE], d.count == 6 {
        link.name = d.map { String(format: "%02x", $0) }.joined()
      } else if let n = advertisementData[CBAdvertisementDataLocalNameKey] as? String, n.count == 12 {
        link.name = n
      }
      m.links[p.identifier] = link
      p.delegate = self
      c.connect(p)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) { p.discoverServices([SERVICE]) }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
      m?.links[p.identifier] = nil
      m?.fails[p.identifier, default: 0] += 1
      rescan(c)
    }

    private func rescan(_ c: CBCentralManager) {
      c.stopScan()
      centralManagerDidUpdateState(c)
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
      guard let m = m, let link = m.links.removeValue(forKey: p.identifier) else { return }
      link.failAll()
      if link.char == nil { m.fails[p.identifier, default: 0] += 1 }
      rescan(c)
      if link.char != nil { m.sendEvent("onPeerLost", ["peerId": p.identifier.uuidString]) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
      guard let svc = p.services?.first(where: { $0.uuid == SERVICE }) else { m?.central?.cancelPeripheralConnection(p); return }
      p.discoverCharacteristics([CHAR], for: svc)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
      guard let m = m, let link = m.links[p.identifier],
            let char = service.characteristics?.first(where: { $0.uuid == CHAR }) else { m?.central?.cancelPeripheralConnection(p); return }
      link.char = char
      m.fails[p.identifier] = nil
      m.sendEvent("onPeer", ["peerId": p.identifier.uuidString, "name": link.name as Any])
    }

    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
      guard let m = m, let link = m.links[p.identifier] else { return }
      m.pump(link)
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
      guard let m = m, let link = m.links[p.identifier] else { return }
      if error != nil { link.failAll(); return }
      let done = link.current?.done
      link.current = nil
      link.busy = false
      done?.resolve(nil)
      m.pump(link)
    }
  }
}
