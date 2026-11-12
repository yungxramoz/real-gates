// Notify adapter: ntfy.sh. `notify.ntfyTopic` is the topic; without one nothing is sent.
// The notify interface: name, send(notifyConfig, title, body). It never throws: a notification
// that cannot be sent must not stop a run.

export const name = 'ntfy';

export async function send(notify, title, body) {
  if (!notify?.ntfyTopic) return;
  try {
    await fetch(`https://ntfy.sh/${notify.ntfyTopic}`, { method: 'POST', headers: { Title: title }, body });
  } catch {}
}
