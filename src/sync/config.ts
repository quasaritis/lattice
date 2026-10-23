/**
 * Public connection settings. The publishable key is meant to ship in browsers: it can only
 * call the lattice_* database functions, join public Realtime channels, upload into an
 * existing board's image folder, and talk to Supabase Auth.
 */
export const SUPABASE_URL = "https://mftkwebfvmmtyqfkizcq.supabase.co";
export const SUPABASE_KEY = "sb_publishable_3wTi38lOUj_cxacdgMga0w_qzMFyF-P";
export const IMAGE_BUCKET = "lattice-images";

export function imageUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${path}`;
}
