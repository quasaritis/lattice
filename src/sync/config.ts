/**
 * Public connection settings. The publishable key is meant to ship in browsers: it can only
 * call the lattice_* database functions, join public Realtime channels, upload into an
 * existing board's image folder, and talk to Supabase Auth.
 */
export const SUPABASE_URL = "https://mftkwebfvmmtyqfkizcq.supabase.co";
export const SUPABASE_KEY = "sb_publishable_3wTi38lOUj_cxacdgMga0w_qzMFyF-P";
export const IMAGE_BUCKET = "lattice-images";

export const VIDEO_BUCKET = "lattice-videos";
/** Biggest video we accept (the bucket's limit). */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export function imageUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${path}`;
}

export function videoUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${VIDEO_BUCKET}/${path}`;
}

/** Public link for an image or video item's storage path. */
export function mediaUrl(kind: string, path: string): string | null {
  if (!path) return null;
  if (kind === "video") return /\.(mp4|webm|mov)$/.test(path) ? videoUrl(path) : null;
  return /\.(webp|jpe?g|png|gif)$/.test(path) ? imageUrl(path) : null;
}
