import type { Run } from "@cursor/sdk";

export function bindRunAbort(run: Run, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};

  const onAbort = () => {
    if (run.supports("cancel")) {
      void run.cancel().catch(() => {});
    }
  };

  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  return () => signal.removeEventListener("abort", onAbort);
}

export async function cancelRunSafely(run: Run): Promise<void> {
  if (!run.supports("cancel")) return;
  try {
    await run.cancel();
  } catch {
    /* ignore */
  }
}

export async function cancelRunIfIncomplete(
  run: Run | undefined,
  completed: boolean,
): Promise<void> {
  if (completed || !run) return;
  await cancelRunSafely(run);
}
