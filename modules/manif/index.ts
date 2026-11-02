// "Mode manif" (Android only, null elsewhere): Brancard shows over the lock screen, a foreground service keeps
// the mesh and GPS alive with the screen off, and wake() lights the screen up on a new alert (like a call).
import { requireOptionalNativeModule } from 'expo';

export default requireOptionalNativeModule<{
  setActive(on: boolean): void;
  wake(title: string, body: string): void;
}>('Manif');
