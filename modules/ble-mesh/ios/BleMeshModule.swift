import CoreBluetooth
import ExpoModulesCore

// Same UUIDs as the Android module: that's the whole cross-platform contract.
private let SERVICE = CBUUID(string: "6f0d7a10-5b8e-4c3a-9d4e-6d656469636d")
private let CHAR = CBUUID(string: "6f0d7a11-5b8e-4c3a-9d4e-6d656469636d")
private let HEADER = 6 // msgId u16, index u16, total u16 (big endian)

/// One outgoing link: we are GATT client, the peer is GATT server. Writes are serialized.
private final class Link {
  let peripheral: CBPeripheral
  var char: CBCharacteristic?
  var queue: [Data] = []
  var busy = false
  init(_ p: CBPeripheral) { peripheral = p }
}

public class BleMeshModule: Module {
  private let q = DispatchQueue(label: "ble-mesh")
  private var central: CBCentralManager?
  private var periph: CBPeripheralManager?
  private var links: [UUID: Link] = [:]
  private var lastTry: [UUID: Date] = [:]
  private var inbox: [String: [Data?]] = [:]
  private var msgId: UInt16 = 0
  private lazy var delegate = Delegate(self)

  public func definition() -> ModuleDefinition {
    Name("BleMesh")
    Events("onPeer", "onPeerLost", "onText")
    AsyncFunction("start") {
      self.q.async {
        if self.central == nil { self.central = CBCentralManager(delegate: self.delegate, queue: self.q) }
        if self.periph == nil { self.periph = CBPeripheralManager(delegate: self.delegate, queue: self.q) }
      }
    }
    AsyncFunction("stop") { self.q.async { self.stop() } }
    AsyncFunction("send") { (peerId: String, text: String) in
      self.q.async { self.send(peerId, text) }
    }
    OnDestroy { self.q.async { self.stop() } }
  }

  private func stop() {
    central?.stopScan()
    links.values.forEach { central?.cancelPeripheralConnection($0.peripheral) }
    links.removeAll()
    periph?.stopAdvertising()
    periph?.removeAllServices()
    central = nil
    periph = nil
  }

  fileprivate func send(_ peerId: String, _ text: String) {
    guard let id = UUID(uuidString: peerId), let link = links[id] else { return }
    let bytes = Data(text.utf8)
    // One ATT packet per chunk, so the peer never needs prepared (long) writes.
    let size = max(20, link.peripheral.maximumWriteValueLength(for: .withoutResponse)) - HEADER
    let total = max(1, (bytes.count + size - 1) / size)
    let mid = msgId; msgId &+= 1
    for i in 0..<total {
      var chunk = Data()
      for v in [mid, UInt16(i), UInt16(total)] { chunk.append(UInt8(v >> 8)); chunk.append(UInt8(v & 0xFF)) }
      chunk.append(bytes.subdata(in: (i * size)..<min(bytes.count, (i + 1) * size)))
      link.queue.append(chunk)
    }
    pump(link)
  }

  fileprivate func pump(_ link: Link) {
    guard !link.busy, let char = link.char, !link.queue.isEmpty else { return }
    link.busy = true
    link.peripheral.writeValue(link.queue.removeFirst(), for: char, type: .withResponse)
  }

  fileprivate func receive(from: String, _ data: Data) {
    guard data.count >= HEADER else { return }
    let b = [UInt8](data)
    let id = Int(b[0]) << 8 | Int(b[1]), index = Int(b[2]) << 8 | Int(b[3]), total = Int(b[4]) << 8 | Int(b[5])
    guard total > 0, index < total, total <= 4096 else { return }
    let key = "\(from):\(id)"
    var parts = inbox[key] ?? Array(repeating: nil, count: total)
    guard parts.count == total else { inbox[key] = nil; return }
    parts[index] = data.subdata(in: HEADER..<data.count)
    if parts.contains(where: { $0 == nil }) { inbox[key] = parts; return }
    inbox[key] = nil
    let text = String(decoding: parts.reduce(Data()) { $0 + $1! }, as: UTF8.self)
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
      if error == nil { p.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [SERVICE]]) }
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
        c.scanForPeripherals(withServices: [SERVICE], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
      }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
      guard let m = m, m.links[p.identifier] == nil,
            Date().timeIntervalSince(m.lastTry[p.identifier] ?? .distantPast) > 3 else { return }
      m.lastTry[p.identifier] = Date()
      m.links[p.identifier] = Link(p) // strong ref, CoreBluetooth drops unreferenced peripherals
      p.delegate = self
      c.connect(p)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) { p.discoverServices([SERVICE]) }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
      m?.links[p.identifier] = nil
      rescan(c)
    }

    private func rescan(_ c: CBCentralManager) {
      c.stopScan()
      centralManagerDidUpdateState(c)
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
      guard let m = m, let link = m.links.removeValue(forKey: p.identifier) else { return }
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
      m.sendEvent("onPeer", ["peerId": p.identifier.uuidString])
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
      guard let m = m, let link = m.links[p.identifier] else { return }
      link.busy = false
      if error != nil { link.queue.removeAll() }
      m.pump(link)
    }
  }
}
