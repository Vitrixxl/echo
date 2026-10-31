// Cross-platform BLE transport: every phone is a GATT server (receives writes) and a
// GATT client (writes to neighbours), so Android and iPhone can talk to each other.
import { requireNativeModule } from 'expo';

type Events = {
  onPeer(e: { peerId: string }): void; // outgoing link ready, we can send()
  onPeerLost(e: { peerId: string }): void;
  onText(e: { peerId: string; text: string }): void; // peerId = sender's id as seen by our server
};

const BleMesh = requireNativeModule<{
  start(): Promise<void>;
  stop(): Promise<void>;
  send(peerId: string, text: string): Promise<void>;
  addListener<K extends keyof Events>(event: K, cb: Events[K]): { remove(): void };
}>('BleMesh');

export default BleMesh;
