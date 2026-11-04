import CoreBluetooth
import ExpoModulesCore

// Same UUIDs as the Android module: that's the whole cross-platform contract. Random, so nothing on the air
// spells out what the app is.
private let SERVICE = CBUUID(string: "dcbe3a65-8595-4490-8012-38f541bb1582")
private let CHAR = CBUUID(string: "dcbe3a66-8595-4490-8012-38f541bb1582")
// Alerts broadcast by Android phones in their advertising (iOS can't broadcast data, it only listens).
private let ADV = CBUUID(string: "dcbe3a67-8595-4490-8012-38f541bb1582")
// Links work both ways: the phone that opened a link writes to us; we answer with notifications on the same
// characteristic, to the phones subscribed to it. One link per pair of phones is then enough, whoever opened it.
private let IN = "in:" // peer ids of phones linked to our GATT server (they opened the link)
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
private let SETUP_TIMEOUT: TimeInterval = 10 // connect + service discovery: CoreBluetooth never gives up by itself

/// One chunk to write; the last chunk of a message carries the JS promise, resolved once it is written.
/// Urgent chunks (alerts) go without write response: no round trip, and every phone of a crowd hears the
/// same alert from several neighbours, so a lost packet doesn't matter.
private struct Chunk { let data: Data; let done: Promise?; var urgent = false }

/// One outgoing link: we are GATT client, the peer is GATT server. We write; it notifies us back.
private final class Link {
  let peripheral: CBPeripheral
  var name: String? // the peer's random mesh name, from its advertising
  var char: CBCharacteristic?
  var ready = false // characteristic found and notifications on (or not offered by an older peer)
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

/// One incoming link: a phone connected to our GATT server and subscribed; we send it notifications.
private final class Sub {
  let central: CBCentral
  var queue: [Chunk] = []
  var stalls = 0 // bumped on each send, so a stale timeout can tell the radio got going again
  init(_ c: CBCentral) { central = c }
  func failAll() {
    for p in queue.compactMap({ $0.done }) { p.reject("ERR_BLE_SEND", "Lien BLE perdu") }
    queue.removeAll()
  }
}

public class BleMeshModule: Module {
  private let q = DispatchQueue(label: "ble-mesh")
  private var central: CBCentralManager?
  private var periph: CBPeripheralManager?
  private var links: [UUID: Link] = [:]
  private var subs: [UUID: Sub] = [:]
  fileprivate var serverChar: CBMutableCharacteristic?
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
    // Back in the app: neighbours are retried at once (no backoff) and the scan restarts.
    AsyncFunction("rescan") {
      self.q.async {
        self.fails.removeAll(); self.lastTry.removeAll()
        if let c = self.central, c.state == .poweredOn { c.stopScan(); self.delegate.centralManagerDidUpdateState(c) }
      }
    }
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
    dropSubs()
    periph?.stopAdvertising()
    periph?.removeAllServices()
    central = nil
    periph = nil
  }

  fileprivate func send(_ peerId: String, _ text: String, _ urgent: Bool, _ promise: Promise) {
    if peerId.hasPrefix(IN) {
      guard let id = UUID(uuidString: String(peerId.dropFirst(IN.count))), let sub = subs[id] else { promise.reject("ERR_BLE_PEER", "Pair BLE inconnu"); return }
      sub.queue += chunks(text, max(20, sub.central.maximumUpdateValueLength), promise, false)
      pumpSubs()
      return
    }
    guard let id = UUID(uuidString: peerId), let link = links[id] else { promise.reject("ERR_BLE_PEER", "Pair BLE inconnu"); return }
    link.queue += chunks(text, max(20, link.peripheral.maximumWriteValueLength(for: .withoutResponse)), promise, urgent)
    pump(link)
  }

  /// One ATT packet per chunk (max bytes each), so the peer never needs prepared (long) writes.
  private func chunks(_ text: String, _ max: Int, _ promise: Promise, _ urgent: Bool) -> [Chunk] {
    let bytes = Data(text.utf8)
    let size = max - HEADER
    let total = Swift.max(1, (bytes.count + size - 1) / size)
    let mid = msgId; msgId &+= 1
    return (0..<total).map { i in
      var chunk = Data()
      for v in [mid, UInt16(i), UInt16(total)] { chunk.append(UInt8(v >> 8)); chunk.append(UInt8(v & 0xFF)) }
      chunk.append(bytes.subdata(in: (i * size)..<Swift.min(bytes.count, (i + 1) * size)))
      return Chunk(data: chunk, done: i == total - 1 ? promise : nil, urgent: urgent)
    }
  }

  /// Notifications to subscribed phones, as fast as the radio takes them (peripheralManagerIsReady resumes).
  fileprivate func pumpSubs() {
    guard let p = periph, let char = serverChar else { return }
    for (id, sub) in subs {
      while let c = sub.queue.first {
        guard p.updateValue(c.data, for: char, onSubscribedCentrals: [sub.central]) else {
          // Queue full: wait for peripheralManagerIsReady. Never ready again (phone gone): drop it.
          sub.stalls += 1
          let n = sub.stalls
          q.asyncAfter(deadline: .now() + WRITE_TIMEOUT) { [weak self] in
            guard let self = self, let s = self.subs[id], s === sub, s.stalls == n, !s.queue.isEmpty else { return }
            self.dropSub(id)
          }
          return
        }
        sub.queue.removeFirst()
        sub.stalls += 1
        c.done?.resolve(nil)
      }
    }
  }

  fileprivate func addSub(_ c: CBCentral) {
    guard subs[c.identifier] == nil else { return }
    subs[c.identifier] = Sub(c)
    sendEvent("onPeer", ["peerId": IN + c.identifier.uuidString, "name": nil as String?])
  }

  fileprivate func dropSub(_ id: UUID) {
    guard let sub = subs.removeValue(forKey: id) else { return }
    sub.failAll()
    sendEvent("onPeerLost", ["peerId": IN + id.uuidString])
  }

  fileprivate func dropSubs() { for id in Array(subs.keys) { dropSub(id) } }

  fileprivate func pump(_ link: Link) {
    guard !link.busy, let char = link.char, !link.queue.isEmpty else { return }
    if link.queue[0].urgent {
      // Without response: no callback per write, the radio's buffer paces us (peripheralIsReady resumes).
      guard link.peripheral.canSendWriteWithoutResponse else {
        // The radio never says ready (Bluetooth off, link half dead): give up and drop the link, like a write
        // that never completes, instead of holding this peer's sends forever.
        let n = link.writes
        q.asyncAfter(deadline: .now() + WRITE_TIMEOUT) { [weak self] in
          guard link.writes == n, !link.queue.isEmpty, !link.peripheral.canSendWriteWithoutResponse else { return }
          link.failAll()
          self?.central?.cancelPeripheralConnection(link.peripheral)
        }
        return
      }
      link.writes += 1
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
      guard p.state == .poweredOn else { m?.dropSubs(); return }
      let svc = CBMutableService(type: SERVICE, primary: true)
      let char = CBMutableCharacteristic(type: CHAR, properties: [.write, .writeWithoutResponse, .notify], value: nil, permissions: [.writeable])
      m?.serverChar = char
      svc.characteristics = [char]
      p.removeAllServices()
      p.add(svc)
    }

    func peripheralManager(_ p: CBPeripheralManager, didAdd service: CBService, error: Error?) {
      // The local name carries our mesh name (iOS can't advertise service data).
      if error == nil { p.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [SERVICE], CBAdvertisementDataLocalNameKey: m?.name ?? ""]) }
    }

    func peripheralManager(_ p: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
      for r in requests where r.characteristic.uuid == CHAR {
        if let v = r.value { m?.receive(from: IN + r.central.identifier.uuidString, v) }
      }
      if let first = requests.first { p.respond(to: first, withResult: .success) }
    }

    func peripheralManager(_ p: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
      if characteristic.uuid == CHAR { m?.addSub(central) }
    }

    func peripheralManager(_ p: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
      if characteristic.uuid == CHAR { m?.dropSub(central.identifier) }
    }

    func peripheralManagerIsReady(toUpdateSubscribers p: CBPeripheralManager) { m?.pumpSubs() }

    // ---- Sending side (GATT client) ----
    func centralManagerDidUpdateState(_ c: CBCentralManager) {
      if c.state != .poweredOn, let m = m, !m.links.isEmpty {
        // Bluetooth off: CoreBluetooth drops every connection without a disconnect callback. Forget them, or
        // they'd fill the link slots and hold their sends forever.
        let lost = m.links
        m.links.removeAll()
        for (id, link) in lost { link.failAll(); if link.ready { m.sendEvent("onPeerLost", ["peerId": id.uuidString]) } }
      }
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
      // A peer gone before the link is usable would hold this slot forever: give up (didDisconnect backs it off).
      m.q.asyncAfter(deadline: .now() + SETUP_TIMEOUT) { [weak m] in
        if let m = m, m.links[p.identifier] === link, !link.ready { m.central?.cancelPeripheralConnection(p) }
      }
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
      if !link.ready { m.fails[p.identifier, default: 0] += 1 }
      rescan(c)
      if link.ready { m.sendEvent("onPeerLost", ["peerId": p.identifier.uuidString]) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
      guard let svc = p.services?.first(where: { $0.uuid == SERVICE }) else { m?.central?.cancelPeripheralConnection(p); return }
      p.discoverCharacteristics([CHAR], for: svc)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
      guard let m = m, let link = m.links[p.identifier],
            let char = service.characteristics?.first(where: { $0.uuid == CHAR }) else { m?.central?.cancelPeripheralConnection(p); return }
      link.char = char
      // Notifications on, so the peer can send to us over this link too (older versions don't offer them).
      if char.properties.contains(.notify) { p.setNotifyValue(true, for: char) } else { ready(m, p, link) }
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
      guard let m = m, let link = m.links[p.identifier], !link.ready, characteristic.uuid == CHAR else { return }
      ready(m, p, link) // even if it failed: one way only, still a link
    }

    private func ready(_ m: BleMeshModule, _ p: CBPeripheral, _ link: Link) {
      link.ready = true
      m.fails[p.identifier] = nil
      m.sendEvent("onPeer", ["peerId": p.identifier.uuidString, "name": link.name as Any])
    }

    // What the peer sends us back over this link.
    func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
      guard error == nil, characteristic.uuid == CHAR, let v = characteristic.value else { return }
      m?.receive(from: p.identifier.uuidString, v)
    }

    // The peer's app restarted (its service was removed and added again): this link points at nothing. Drop it;
    // the scan finds the peer again and a fresh link syncs it.
    func peripheral(_ p: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
      if invalidatedServices.contains(where: { $0.uuid == SERVICE }) { m?.central?.cancelPeripheralConnection(p) }
    }

    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
      guard let m = m, let link = m.links[p.identifier] else { return }
      m.pump(link)
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
      guard let m = m, let link = m.links[p.identifier] else { return }
      if error != nil { link.failAll(); m.central?.cancelPeripheralConnection(p); return } // see Android: link in doubt
      let done = link.current?.done
      link.current = nil
      link.busy = false
      done?.resolve(nil)
      m.pump(link)
    }
  }
}
