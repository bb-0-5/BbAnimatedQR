/**
 * Utilities for high-speed file compression and Base64 conversion
 * using browser-native APIs.
 */

/**
 * Compresses bytes using native gzip.
 */
export async function compressBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    // Fallback if not supported (e.g., very old browsers)
    return bytes;
  }
  const stream = new Blob([bytes]).stream();
  const compressionStream = new CompressionStream('gzip');
  const compressedStream = stream.pipeThrough(compressionStream);
  const response = new Response(compressedStream);
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Decompresses bytes using native gzip.
 */
export async function decompressBytes(compressedBytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    return compressedBytes;
  }
  const stream = new Blob([compressedBytes]).stream();
  const decompressionStream = new DecompressionStream('gzip');
  const decompressedStream = stream.pipeThrough(decompressionStream);
  const response = new Response(decompressedStream);
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Converts a Uint8Array of bytes into a Base64 string safely.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Safe chunked conversion to prevent call stack size exceeded warnings on large arrays
  const chunks: string[] = [];
  const chunkSize = 0xffff; // 64kb chunks
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
  }
  return btoa(chunks.join(''));
}

/**
 * Converts a Base64 string back into a Uint8Array.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generate a small random ID to uniquely identify a file transfer session.
 */
export function generateFileId(): string {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}
