export interface TransferMetadata {
  name: string;
  type: string;
  size: number;
  differential?: boolean;
}

export interface QRChunk {
  fileId: string;
  index: number;
  total: number;
  payload: string; // Base64 chunk or string
}

export interface TransferStats {
  chunksScanned: number;
  totalChunks: number;
  scannedIndices: Set<number>;
  startTime: number | null;
  endTime: number | null;
  duplicateCount: number;
  currentSpeed: number; // chunks per second
  errorCount: number;
}
