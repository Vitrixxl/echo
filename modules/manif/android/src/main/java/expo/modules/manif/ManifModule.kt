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

    // Shown over the lock screen (mode manif only). The rest of the phone stays locked.
    Function("setOverLock") { on: Boolean ->
      appContext.currentActivity?.let { a ->
        if (Build.VERSION.SDK_INT >= 27) a.runOnUiThread { a.setShowWhenLocked(on); a.setTurnScreenOn(on) }
      }
    }

    // Keeps the process alive with the screen off (relay, GPS, alerts): always for medics, and in mode manif.
    Function("setRelay") { on: Boolean ->
      val i = Intent(ctx, ManifService::class.java)
      if (!on) ctx.stopService(i)
      else if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
    }

    // Mode manif: asks once to be left out of battery optimisation, or Doze and the makers' battery savers
    // (Xiaomi, Samsung, Huawei…) still kill the relay after a while, foreground service or not.
    Function("keepAlive") {
      val pm = ctx.getSystemService(android.os.PowerManager::class.java)
      if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(ctx.packageName)) runCatching {
        ctx.startActivity(Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
          .setData(android.net.Uri.parse("package:" + ctx.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }

    // What would keep a medic's alarm silent: notifications off, full-screen alerts not allowed (Android 14+
    // can withdraw it), Do Not Disturb on.
    Function("alarmIssues") {
      val nm = ctx.getSystemService(NotificationManager::class.java)
      listOfNotNull(
        "notifications".takeIf { !nm.areNotificationsEnabled() },
        "fullscreen".takeIf { Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent() },
        "dnd".takeIf { Build.VERSION.SDK_INT >= 23 && nm.currentInterruptionFilter > NotificationManager.INTERRUPTION_FILTER_ALL },
      )
    }

    // The settings screen that fixes one of those.
    Function("openSettings") { issue: String ->
      val pkg = android.net.Uri.parse("package:" + ctx.packageName)
      val i = when (issue) {
        "notifications" -> Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        "fullscreen" -> if (Build.VERSION.SDK_INT >= 34) Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg) else null
        "dnd" -> Intent("android.settings.ZEN_MODE_SETTINGS")
        else -> null
      } ?: Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
      runCatching { ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    // A full-screen notification: with the screen off the system turns it on and opens Brancard over the lock screen.
    Function("wake") { title: String, body: String ->
      val nm = ctx.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26)
        nm.createNotificationChannel(NotificationChannel(WAKE_CH, "Alertes medic (plein écran)", NotificationManager.IMPORTANCE_HIGH).apply {
          vibrationPattern = longArrayOf(0, 500, 200, 500, 200, 500)
          enableVibration(true)
        })
      val open = openApp(ctx, 1)
      // On the lock screen only "Brancard: nouvelle alerte" shows; the details need the phone unlocked.
      val public = notification(ctx, WAKE_CH).setSmallIcon(R.drawable.manif_notif).setContentTitle("Brancard").setContentText("Nouvelle alerte").build()
      val n = notification(ctx, WAKE_CH)
        .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(public)
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
      .setSmallIcon(R.drawable.manif_notif).setContentTitle("Brancard relaie les alertes")
      .setContentText("Écran éteint, tu restes joignable.").setOngoing(true).setContentIntent(openApp(this, 0)).build()
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
