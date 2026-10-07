// Shared between the worklet and the main thread (keep import-free).
/** SharedArrayBuffer telemetry layout (docs/ARCHITECTURE.md "Telemetry transport") */
export const SHM = { HEADER: 8, SEQ: 0, TEL_LEN: 1, PAD_COUNT: 2, FRAME: 3, TEL_CAP: 4096, PAD_CAP: 256 } as const;
export const SHM_BYTES = SHM.HEADER * 4 + (SHM.TEL_CAP + SHM.PAD_CAP) * 4;

