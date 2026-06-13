/**
 * Base64 JSON file upload that survives Capacitor on iOS.
 *
 * Why this exists: we enabled `CapacitorHttp` so cross-origin
 * `fetch()` calls from `capacitor://localhost` work natively
 * (URLSession) and bypass WKWebView's custom-scheme CORS errors.
 * But that plugin patches BOTH `fetch` AND `XMLHttpRequest` and
 * its FormData serializer mangles binary payloads — every chat
 * image / avatar / status upload lands at the server malformed
 * and Pillow rejects it.
 *
 * Workaround: encode the image to base64 client-side and POST it
 * as JSON. CapacitorHttp passes JSON bodies through cleanly, and
 * the backend image endpoints accept either multipart (PWA path)
 * or JSON (Capacitor path) via the same `_read_image_bytes`
 * helper.
 *
 * Returns the parsed JSON response; throws on non-2xx.
 */

interface UploadOptions {
  /** Extra headers — typically `X-App-Password` + `X-Session-Token`. */
  headers?: Record<string, string>;
  /** Extra string form fields (caption, reply_to_id, etc.). */
  fields?: Record<string, string>;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const result = fr.result;
      if (typeof result !== "string") {
        reject(new Error("expected string from FileReader"));
        return;
      }
      // result is `data:image/png;base64,<...>` — strip the prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    fr.onerror = () => reject(fr.error ?? new Error("read error"));
    fr.readAsDataURL(file);
  });
}

export async function uploadFile<T>(
  url: string,
  file: File,
  opts?: UploadOptions,
): Promise<T> {
  const data_base64 = await fileToBase64(file);
  const body = {
    filename: file.name || "upload.bin",
    mime: file.type || "application/octet-stream",
    data_base64,
    ...(opts?.fields ?? {}),
  };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts?.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}
