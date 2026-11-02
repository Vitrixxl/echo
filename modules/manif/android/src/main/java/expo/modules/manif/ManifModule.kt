package expo.modules.manif

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val SERVICE_CH = "manif"
private const val WAKE_CH = "sos_wake"

private fun notification(ctx: Context, ch: String): Notification.Builder =
  if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, ch) else @Suppress("DEPRECATION") Notification.Builder(ctx)

/** Opens (or brings back) Écho's activity. */
private fun openApp(ctx: Context, req: Int): PendingIntent {
  val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)!!.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
  return PendingIntent.getActivity(ctx, req, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

class ManifModule : Module() {
  private val ctx: Context get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("Manif")

    Function("setActive") { on: Boolean ->
      appContext.currentActivity?.let { a ->
        // The rest of the phone stays locked: leaving Écho asks for the code again.
        if (Build.VERSION.SDK_INT >= 27) a.runOnUiThread { a.setShowWhenLocked(on); a.setTurnScreenOn(on) }
      }
      val i = Intent(ctx, ManifService::class.java)
      if (!on) ctx.stopService(i)
      else if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
    }

    // A full-screen notification: with the screen off the system turns it on and opens Écho over the lock screen.
    Function("wake") { title: String, body: String ->
      val nm = ctx.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26)
        nm.createNotificationChannel(NotificationChannel(WAKE_CH, "Alertes medic (plein écran)", NotificationManager.IMPORTANCE_HIGH).apply {
          vibrationPattern = longArrayOf(0, 500, 200, 500, 200, 500)
          enableVibration(true)
        })
      val open = openApp(ctx, 1)
      val n = notification(ctx, WAKE_CH)
        .setSmallIcon(R.drawable.manif_notif).setContentTitle(title).setContentText(body)
        .setCategory(Notification.CATEGORY_ALARM).setContentIntent(open).setFullScreenIntent(open, true).setAutoCancel(true)
      if (Build.VERSION.SDK_INT >= 26) n.setTimeoutAfter(120_000)
      nm.notify(2, n.build())
    }
  }
}

/** Keeps the process (mesh relay + GPS) running with the screen off, behind an ongoing notification. */
class ManifService : Service() {
  override fun onBind(intent: Intent?) = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26)
      nm.createNotificationChannel(NotificationChannel(SERVICE_CH, "Mode manif", NotificationManager.IMPORTANCE_LOW))
    val n = notification(this, SERVICE_CH)
      .setSmallIcon(R.drawable.manif_notif).setContentTitle("Mode manif activé")
      .setContentText("Écho s'affiche dès que tu rallumes l'écran.").setOngoing(true).setContentIntent(openApp(this, 0)).build()
    if (Build.VERSION.SDK_INT < 29) startForeground(1, n)
    else {
      // Each type needs its permission granted (Android 14): fall back to what we have.
      val L = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
      val D = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
      if (listOf(L or D, D, L).none { runCatching { startForeground(1, n, it) }.isSuccess }) stopSelf()
    }
    return START_NOT_STICKY
  }
}
