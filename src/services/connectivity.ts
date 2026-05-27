import { Capacitor } from "@capacitor/core";
import { Network } from "@capacitor/network";

export const offlineNotice = "Offline. Continue trabalhando; sincroniza ao reconectar.";

export async function isDeviceOnline() {
  if (Capacitor.isNativePlatform()) {
    try {
      return (await Network.getStatus()).connected;
    } catch {
      return navigator.onLine;
    }
  }

  return navigator.onLine;
}

export function isConnectionFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");

  return /failed to fetch|network|internet|offline|load failed|unable to resolve|failed to connect|connection|socket|timeout|timed out|err_|host|n[aã]o houve resposta da api/i.test(
    message,
  );
}

export async function addNetworkListener(onChange: (connected: boolean) => void) {
  if (Capacitor.isNativePlatform()) {
    const handle = await Network.addListener("networkStatusChange", (status) => {
      onChange(status.connected);
    });

    return () => handle.remove();
  }

  const handleOnline = () => onChange(true);
  const handleOffline = () => onChange(false);

  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);

  return async () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
  };
}
