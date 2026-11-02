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
const val HEADER = 6 // msgId u16, index u16, total u16
// Reassembly limits: anyone can write to the GATT server, so partial messages must not pile up in memory.
const val MAX_PARTS = 1024 // ~180 KB at a 185-byte MTU; real messages are a few KB
const val MAX_PENDING_PER_PEER = 4
const val MAX_PENDING = 64
const val PENDING_MS = 15_000L

class Partial(val parts: Array<ByteArray?>, val at: Long)

/** One outgoing link: we are GATT client, the peer is GATT server. Writes are serialized. */
class Link(val gatt: BluetoothGatt) {
  var char: BluetoothGattCharacteristic? = null
  var mtu = 23
  val queue = ArrayDeque<ByteArray>()
  var busy = false
}

@SuppressLint("MissingPermission")
class BleMeshModule : Module() {
  private val ctx: Context get() = requireNotNull(appContext.reactContext)
  private val manager get() = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private var server: BluetoothGattServer? = null
  private val links = ConcurrentHashMap<String, Link>()
  private val lastTry = ConcurrentHashMap<String, Long>()
  private val inbox = LinkedHashMap<String, Partial>() // insertion order = age; guarded by synchronized(inbox)
  private var msgId = 0

  override fun definition() = ModuleDefinition {
    Name("BleMesh")
    Events("onPeer", "onPeerLost", "onText")
    AsyncFunction("start") { start() }
    AsyncFunction("stop") { stop() }
    AsyncFunction("send") { peerId: String, text: String -> send(peerId, text) }
    OnDestroy { stop() }
  }

  private fun start() {
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
      advertiseCallback,
    )
    adapter.bluetoothLeScanner?.startScan(
      listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()),
      // Battery: BALANCED scans ~25% of the time instead of 100%; discovery takes a few s longer.
      ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build(),
      scanCallback,
    )
  }

  private fun stop() {
    val adapter = manager.adapter ?: return
    runCatching { adapter.bluetoothLeScanner?.stopScan(scanCallback) }
    runCatching { adapter.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) }
    links.values.forEach { runCatching { it.gatt.close() } }
    links.clear()
    runCatching { server?.close() }
    server = null
  }

  private fun send(peerId: String, text: String) {
    val link = links[peerId] ?: throw Exception("Pair BLE inconnu")
    val bytes = text.toByteArray(Charsets.UTF_8)
    val size = link.mtu - 3 - HEADER // one ATT packet, so the peer never needs prepared writes
    val total = (bytes.size + size - 1) / size
    val id = (msgId++) and 0xFFFF
    synchronized(link) {
      for (i in 0 until maxOf(total, 1)) {
        val part = bytes.copyOfRange(i * size, minOf(bytes.size, (i + 1) * size))
        link.queue.addLast(ByteBuffer.allocate(HEADER + part.size)
          .putShort(id.toShort()).putShort(i.toShort()).putShort(maxOf(total, 1).toShort()).put(part).array())
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
      chunk = link.queue.removeFirstOrNull() ?: return
      link.busy = true
    }
    val type = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
    val ok = if (Build.VERSION.SDK_INT >= 33) {
      link.gatt.writeCharacteristic(char, chunk, type) == BluetoothStatusCodes.SUCCESS
    } else {
      @Suppress("DEPRECATION") run { char.writeType = type; char.value = chunk; link.gatt.writeCharacteristic(char) }
    }
    if (!ok) { synchronized(link) { link.queue.clear(); link.busy = false } }
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
      val addr = result.device.address
      val now = System.currentTimeMillis()
      if (links.containsKey(addr) || now - (lastTry[addr] ?: 0) < 10_000) return
      lastTry[addr] = now
      val gatt = result.device.connectGatt(ctx, false, gattCallback, BluetoothDevice.TRANSPORT_LE) ?: return
      links[addr] = Link(gatt)
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val addr = gatt.device.address
      if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
        gatt.requestMtu(517)
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
        val wasReady = links.remove(addr)?.char != null
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
      sendEvent("onPeer", mapOf("peerId" to gatt.device.address))
    }

    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      val link = links[gatt.device.address] ?: return
      synchronized(link) {
        link.busy = false
        if (status != BluetoothGatt.GATT_SUCCESS) link.queue.clear()
      }
      pump(link)
    }
  }
}
