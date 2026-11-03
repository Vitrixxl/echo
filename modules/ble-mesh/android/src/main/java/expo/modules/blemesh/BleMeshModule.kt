package expo.modules.blemesh

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// Same UUIDs as ios/BleMeshModule.swift: that's the whole cross-platform contract. Random, so nothing on the
// air spells out what the app is.
val SERVICE: UUID = UUID.fromString("dcbe3a65-8595-4490-8012-38f541bb1582")
val CHAR: UUID = UUID.fromString("dcbe3a66-8595-4490-8012-38f541bb1582")
// Alerts broadcast in the advertising signal itself (no link needed): service data under this UUID.
val ADV: UUID = UUID.fromString("dcbe3a67-8595-4490-8012-38f541bb1582")
const val ADV_KEEP_MS = 60_000L // each change is broadcast fast for a minute (closed alerts: then dropped)
const val ADV_OPEN_MS = 6 * 3600_000L // open alerts stay on air, slowly, until closed (6 h: their lifetime)
const val ADV_ROTATE_MS = 600L // several alerts take turns in the one advertising set
const val ADV_ROTATE_SLOW_MS = 1500L // once every alert on air is past its first minute
const val HEADER = 6 // msgId u16, index u16, total u16
// Reassembly limits: anyone can write to the GATT server, so partial messages must not pile up in memory.
const val MAX_PARTS = 1024 // ~180 KB at a 185-byte MTU; real messages are a few KB
const val MAX_PENDING_PER_PEER = 4
const val MAX_PENDING = 64
const val PENDING_MS = 15_000L

class Partial(val parts: Array<ByteArray?>, val at: Long)

const val MAX_LINKS = 7 // outgoing links; flooding only needs the crowd connected, more links just add traffic
const val MIN_RSSI = -90 // weaker advertisers are at the edge of range: their links fail and churn
const val WRITE_TIMEOUT_MS = 15_000L

/** One chunk to write; the last chunk of a message carries the JS promise, resolved once it is written.
 *  Urgent chunks (alerts) go without write response: no round trip per packet, and losses don't matter
 *  since every phone of a crowd hears the same alert from several neighbours. */
class Chunk(val bytes: ByteArray, val done: expo.modules.kotlin.Promise?, val urgent: Boolean = false)

/** One outgoing link: we are GATT client, the peer is GATT server. Writes are serialized. */
class Link(val gatt: BluetoothGatt, val name: String?) { // name: the peer's random mesh name, from its advertising
  var char: BluetoothGattCharacteristic? = null
  var mtu = 23
  val queue = ArrayDeque<Chunk>()
  var current: Chunk? = null
  var busy = false

  /** Fails every message still waiting (link lost or write error): the JS side then resends elsewhere. */
  fun failAll() {
    val pending = synchronized(this) { val l = listOfNotNull(current?.done) + queue.mapNotNull { it.done }; queue.clear(); current = null; busy = false; l }
    pending.forEach { it.reject("ERR_BLE_SEND", "Lien BLE perdu", null) }
  }
}

@SuppressLint("MissingPermission")
class BleMeshModule : Module() {
  private val ctx: Context get() = requireNotNull(appContext.reactContext)
  private val manager get() = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private var server: BluetoothGattServer? = null
  private val links = ConcurrentHashMap<String, Link>()
  private val lastTry = ConcurrentHashMap<String, Long>()
  private val fails = ConcurrentHashMap<String, Int>() // failed connections per address, for backoff
  private val watchdog = android.os.Handler(android.os.Looper.getMainLooper())
  private val inbox = LinkedHashMap<String, Partial>() // insertion order = age; guarded by synchronized(inbox)
  private var msgId = 0

  override fun definition() = ModuleDefinition {
    Name("BleMesh")
    Events("onPeer", "onPeerLost", "onText")
    // name: this launch's random mesh name (12 hex chars), advertised so a neighbour also linked over Nearby
    // or Multipeer can recognise us and keep a single link.
    AsyncFunction("start") { name: String -> start(name) }
    AsyncFunction("stop") { stop() }
    // Resolves once the whole message is written to the peer: the JS outbox sends the next one only then, so
    // it can put alerts first and drop outdated positions instead of piling them up here.
    AsyncFunction("send") { peerId: String, text: String, urgent: Boolean, promise: expo.modules.kotlin.Promise -> send(peerId, text, urgent, promise) }
    // Puts an alert (base64 of a one-record message) in the broadcast rotation: fast for ADV_KEEP_MS, then
    // slowly for as long as it's open (a medic who walks in later hears it at once, linked or not).
    Function("broadcast") { id: String, text: String, open: Boolean -> broadcast(id, text, open) }
    OnDestroy { stop() }
  }

  private fun start(name: String) {
    val adapter = manager.adapter ?: throw Exception("Bluetooth indisponible")
    if (!adapter.isEnabled) throw Exception("Active le Bluetooth")
    if (server == null) {
      server = manager.openGattServer(ctx, serverCallback)?.also {
        val svc = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        svc.addCharacteristic(BluetoothGattCharacteristic(
          CHAR,
          BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
          BluetoothGattCharacteristic.PERMISSION_WRITE,
        ))
        it.addService(svc)
      }
    }
    adapter.bluetoothLeAdvertiser?.startAdvertising(
      AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED) // 250 ms interval: ~3x less than LOW_LATENCY
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(true).build(),
      AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE)).build(),
      // Scan response (sent to active scanners): our mesh name, 6 bytes.
      AdvertiseData.Builder().addServiceData(ParcelUuid(SERVICE), hexBytes(name)).build(),
      advertiseCallback,
    )
    val scan = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED) // ~25 % of the time
    // Extended advertising (broadcast alerts) is only reported with legacy-only scanning turned off.
    if (Build.VERSION.SDK_INT >= 26 && adapter.isLeExtendedAdvertisingSupported) scan.setLegacy(false).setPhy(ScanSettings.PHY_LE_ALL_SUPPORTED)
    adapter.bluetoothLeScanner?.startScan(
      listOf(
        ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build(),
        ScanFilter.Builder().setServiceData(ParcelUuid(ADV), ByteArray(0), ByteArray(0)).build(),
      ),
      scan.build(),
      scanCallback,
    )
  }

  private fun hexBytes(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

  /** The mesh name a scanned phone advertises: service data (Android) or local name (iPhone). */
  private fun nameOf(r: ScanResult): String? {
    r.scanRecord?.getServiceData(ParcelUuid(SERVICE))?.takeIf { it.size == 6 }?.let { b -> return b.joinToString("") { "%02x".format(it) } }
    return r.scanRecord?.deviceName?.takeIf { Regex("^[0-9a-f]{12}$").matches(it) }
  }

  private fun stop() {
    val adapter = manager.adapter ?: return
    runCatching { adapter.bluetoothLeScanner?.stopScan(scanCallback) }
    runCatching { adapter.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) }
    runCatching { adapter.bluetoothLeAdvertiser?.stopAdvertisingSet(advSetCallback) }
    watchdog.post { advs.clear(); advSet = null; watchdog.removeCallbacks(rotator) }
    links.values.forEach { it.failAll(); runCatching { it.gatt.close() } }
    links.clear()
    runCatching { server?.close() }
    server = null
  }

  private fun send(peerId: String, text: String, urgent: Boolean, promise: expo.modules.kotlin.Promise) {
    val link = links[peerId] ?: return promise.reject("ERR_BLE_PEER", "Pair BLE inconnu", null)
    if (urgent) fast(link)
    val bytes = text.toByteArray(Charsets.UTF_8)
    val size = link.mtu - 3 - HEADER // one ATT packet, so the peer never needs prepared writes
    val total = (bytes.size + size - 1) / size
    val id = (msgId++) and 0xFFFF
    synchronized(link) {
      val n = maxOf(total, 1)
      for (i in 0 until n) {
        val part = bytes.copyOfRange(i * size, minOf(bytes.size, (i + 1) * size))
        val b = ByteBuffer.allocate(HEADER + part.size)
          .putShort(id.toShort()).putShort(i.toShort()).putShort(n.toShort()).put(part).array()
        link.queue.addLast(Chunk(b, if (i == n - 1) promise else null, urgent))
      }
    }
    pump(link)
  }

  private fun pump(link: Link) {
    val chunk: ByteArray
    val char: BluetoothGattCharacteristic
    synchronized(link) {
      if (link.busy) return
      char = link.char ?: return
      val c = link.queue.removeFirstOrNull() ?: return
      link.current = c
      link.busy = true
      chunk = c.bytes
    }
    val type = if (link.current?.urgent == true) BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE else BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
    val ok = if (Build.VERSION.SDK_INT >= 33) {
      link.gatt.writeCharacteristic(char, chunk, type) == BluetoothStatusCodes.SUCCESS
    } else {
      @Suppress("DEPRECATION") run { char.writeType = type; char.value = chunk; link.gatt.writeCharacteristic(char) }
    }
    if (!ok) { link.failAll(); return }
    // A write that never completes (stack stall) would block this link forever: give up and drop it.
    val sent = link.current
    watchdog.postDelayed({ if (link.current === sent && sent != null) { link.failAll(); runCatching { link.gatt.disconnect() } } }, WRITE_TIMEOUT_MS)
  }

  /** Links idle in low-power mode (an exchange every ~100 ms); an alert switches the link to the fast mode
   *  (~15 ms) for a few seconds, then back. Batteries for positions, speed for alerts. */
  private val slowDown = HashMap<Link, Runnable>()
  private fun fast(link: Link) {
    runCatching { link.gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH) }
    watchdog.post {
      slowDown.remove(link)?.let { watchdog.removeCallbacks(it) }
      val r = Runnable { slowDown.remove(link); runCatching { link.gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_LOW_POWER) } }
      slowDown[link] = r
      watchdog.postDelayed(r, 8_000L)
    }
  }

  // ---- Broadcast (alerts in the advertising signal, received by every phone in range, no link needed) ----
  // Needs BLE 5 extended advertising to fit a whole alert (~60 bytes); older phones only receive.

  private class Adv(val data: ByteArray, val at: Long, val open: Boolean)
  private val advs = LinkedHashMap<String, Adv>() // main thread only
  private var advSet: AdvertisingSet? = null
  private var advStarting = false
  private var advTurn = 0
  private var advFast = true // the running set's interval
  private val seenAdv = LinkedHashMap<String, Long>() // payloads already passed to JS, to skip repeats

  private fun broadcast(id: String, text: String, open: Boolean) {
    val data = android.util.Base64.decode(text, android.util.Base64.NO_WRAP)
    watchdog.post {
      advs.remove(id)
      advs[id] = Adv(data, System.currentTimeMillis(), open)
      seenAdv[text] = System.currentTimeMillis() // our own: don't hand it back to JS when we hear it relayed
      rotate()
    }
  }

  private val rotator = Runnable { rotate() }
  private fun rotate() {
    watchdog.removeCallbacks(rotator)
    val now = System.currentTimeMillis()
    advs.values.removeAll { now - it.at > (if (it.open) ADV_OPEN_MS else ADV_KEEP_MS) }
    // ~100 ms while something just changed, ~1 s after: a few open alerts on air cost next to nothing.
    val fast = advs.values.any { now - it.at < ADV_KEEP_MS }
    val adapter = manager.adapter
    val advertiser = adapter?.bluetoothLeAdvertiser
    if (advs.isEmpty() || adapter == null || advertiser == null || Build.VERSION.SDK_INT < 26 || !adapter.isLeExtendedAdvertisingSupported) {
      advSet?.let { runCatching { advertiser?.stopAdvertisingSet(advSetCallback) } }
      advSet = null
      return
    }
    val list = advs.values.toList()
    // The UUID is listed too: iPhones can only scan for listed service UUIDs.
    val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(ADV)).addServiceData(ParcelUuid(ADV), list[advTurn++ % list.size].data).build()
    val set = advSet
    if (set != null && advFast != fast) { // interval change: restart the set on the next turn
      runCatching { advertiser.stopAdvertisingSet(advSetCallback) }
      advSet = null
    } else if (set != null) runCatching { set.setAdvertisingData(data) }
    else if (!advStarting) {
      advStarting = true
      advFast = fast
      val params = AdvertisingSetParameters.Builder()
        .setLegacyMode(false).setConnectable(false).setScannable(false)
        .setInterval(if (fast) AdvertisingSetParameters.INTERVAL_LOW else AdvertisingSetParameters.INTERVAL_HIGH)
        .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_HIGH)
        .setPrimaryPhy(BluetoothDevice.PHY_LE_1M).setSecondaryPhy(BluetoothDevice.PHY_LE_1M).build()
      runCatching { advertiser.startAdvertisingSet(params, data, null, null, null, advSetCallback) }.onFailure { advStarting = false }
    }
    watchdog.postDelayed(rotator, if (fast) ADV_ROTATE_MS else ADV_ROTATE_SLOW_MS)
  }

  private val advSetCallback = object : AdvertisingSetCallback() {
    override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, status: Int) {
      watchdog.post { advStarting = false; advSet = if (status == ADVERTISE_SUCCESS) set else null }
    }
    override fun onAdvertisingSetStopped(set: AdvertisingSet?) { watchdog.post { if (advSet === set) advSet = null } }
  }

  /** An alert heard in someone's advertising: handed to JS once per payload (repeats every 100 ms otherwise). */
  private fun heard(data: ByteArray) {
    val text = android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP)
    watchdog.post {
      val now = System.currentTimeMillis()
      if (now - (seenAdv[text] ?: 0) < ADV_KEEP_MS) return@post
      seenAdv[text] = now
      while (seenAdv.size > 256) seenAdv.remove(seenAdv.keys.first())
      sendEvent("onText", mapOf("peerId" to "adv", "text" to text))
    }
  }

  // ---- Receiving side (GATT server) ----

  private fun receive(from: String, data: ByteArray) {
    if (data.size < HEADER) return
    val b = ByteBuffer.wrap(data)
    val id = b.short.toInt() and 0xFFFF
    val index = b.short.toInt() and 0xFFFF
    val total = b.short.toInt() and 0xFFFF
    if (total == 0 || index >= total || total > MAX_PARTS) return
    val key = "$from:$id"
    val now = System.currentTimeMillis()
    val parts: Array<ByteArray?>
    synchronized(inbox) {
      inbox.values.removeAll { now - it.at > PENDING_MS }
      var p = inbox[key]
      if (p == null) {
        // Too many unfinished messages from this sender, or overall: forget the oldest.
        inbox.keys.filter { it.startsWith("$from:") }.dropLast(MAX_PENDING_PER_PEER - 1).forEach { inbox.remove(it) }
        while (inbox.size >= MAX_PENDING) inbox.remove(inbox.keys.first())
        p = Partial(arrayOfNulls(total), now)
        inbox[key] = p
      }
      if (p.parts.size != total) { inbox.remove(key); return }
      p.parts[index] = data.copyOfRange(HEADER, data.size)
      if (p.parts.any { it == null }) return
      inbox.remove(key)
      parts = p.parts
    }
    val out = java.io.ByteArrayOutputStream()
    for (part in parts) out.write(part!!)
    sendEvent("onText", mapOf("peerId" to from, "text" to out.toString(Charsets.UTF_8.name())))
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?,
    ) {
      // ponytail: prepared (long) writes are ignored; senders cap chunks to one ATT packet.
      if (characteristic.uuid == CHAR && value != null && !preparedWrite) receive(device.address, value)
      if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
    }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_DISCONNECTED) synchronized(inbox) { inbox.keys.removeAll { it.startsWith(device.address + ":") } }
    }
  }

  private val advertiseCallback = object : AdvertiseCallback() {}

  // ---- Sending side (GATT client) ----

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      result.scanRecord?.getServiceData(ParcelUuid(ADV))?.let { heard(it); return }
      val addr = result.device.address
      val now = System.currentTimeMillis()
      // Backoff 10 s, 20 s… up to ~5 min for addresses that keep failing; a cap on links; skip weak signals.
      val wait = 10_000L shl minOf(fails[addr] ?: 0, 5)
      if (links.containsKey(addr) || links.size >= MAX_LINKS || result.rssi < MIN_RSSI || now - (lastTry[addr] ?: 0) < wait) return
      if (lastTry.size > 2000) lastTry.clear() // rotating addresses: don't grow forever
      lastTry[addr] = now
      val gatt = result.device.connectGatt(ctx, false, gattCallback, BluetoothDevice.TRANSPORT_LE) ?: return
      links[addr] = Link(gatt, nameOf(result))
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val addr = gatt.device.address
      if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
        gatt.requestMtu(517)
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
        val link = links.remove(addr)
        val wasReady = link?.char != null
        link?.failAll()
        if (!wasReady) fails[addr] = (fails[addr] ?: 0) + 1
        runCatching { gatt.close() }
        if (wasReady) sendEvent("onPeerLost", mapOf("peerId" to addr))
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      links[gatt.device.address]?.mtu = if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23
      gatt.discoverServices()
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val link = links[gatt.device.address] ?: return
      val char = gatt.getService(SERVICE)?.getCharacteristic(CHAR)
      if (char == null) { gatt.disconnect(); return }
      link.char = char
      fails.remove(gatt.device.address)
      // Idle links don't need fast connection events: saves battery on every link.
      gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_LOW_POWER)
      sendEvent("onPeer", mapOf("peerId" to gatt.device.address, "name" to link.name))
    }

    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      val link = links[gatt.device.address] ?: return
      if (status != BluetoothGatt.GATT_SUCCESS) { link.failAll(); return }
      val done = synchronized(link) { val d = link.current?.done; link.current = null; link.busy = false; d }
      done?.resolve(null)
      pump(link)
    }
  }
}
