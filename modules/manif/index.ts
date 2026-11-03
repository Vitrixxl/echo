// Android only (null elsewhere). setRelay: a foreground service keeps the mesh, GPS and alerts alive with the
// screen off (always on for medics, and in mode manif). setOverLock: mode manif, Brancard shows over the lock
// screen. wake(): lights the screen up on a new alert, like a call.
import { requireOptionalNativeModule } from 'expo';

export default requireOptionalNativeModule<{
  setRelay(on: boolean): void;
  setOverLock(on: boolean): void;
  wake(title: string, body: string): void;
  keepAlive(): void; // asks to be left out of battery optimisation (once: no-op when already granted)
}>('Manif');
