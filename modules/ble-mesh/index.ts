// Cross-platform BLE transport: every phone is a GATT server (receives writes) and a
// GATT client (writes to neighbours), so Android and iPhone can talk to each other.
import { requireNativeModule } from 'expo';

type Events = {
  onPeer(e: { peerId: string; name?: string | null }): void; // outgoing link ready; name: the peer's mesh name if advertised
  onPeerLost(e: { peerId: string }): void;
  onText(e: { peerId: string; text: string }): void; // peerId = sender's id as seen by our server; "adv" = heard in a broadcast
};

const BleMesh = requireNativeModule<{
  start(name: string): Promise<void>;
  stop(): Promise<void>;
  /** Resolves once written. urgent: alerts, sent without write response on a link switched to its fast mode. */
  send(peerId: string, text: string, urgent: boolean): Promise<void>;
  /** Android with BLE 5: broadcasts this one-alert message in the advertising signal for a minute (iOS: no-op). */
  broadcast(id: string, text: string): void;
  addListener<K extends keyof Events>(event: K, cb: Events[K]): { remove(): void };
}>('BleMesh');

export default BleMesh;
