import React, { useState, useEffect, useRef, useCallback } from 'react';
import jsQR from 'jsqr';
import { Camera, RefreshCw, Download, CheckCircle, AlertCircle, FileCheck, Layers, Video, Play, Pause, Volume2, VolumeX } from 'lucide-react';
import { decompressBytes, base64ToBytes } from '../utils/compressor';
import { TransferMetadata, TransferStats } from '../types';

interface ReceiverProps {
  onBackToMenu: () => void;
}

function detectQRColor(imageData: ImageData, location: { topLeftCorner: { x: number; y: number }; topRightCorner: { x: number; y: number }; bottomRightCorner: { x: number; y: number }; bottomLeftCorner: { x: number; y: number } }): 'cyan' | 'magenta' | 'yellow' | 'green' | 'monochrome' {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;
  const centerX = Math.round((topLeftCorner.x + topRightCorner.x + bottomRightCorner.x + bottomLeftCorner.x) / 4);
  const centerY = Math.round((topLeftCorner.y + topRightCorner.y + bottomRightCorner.y + bottomLeftCorner.y) / 4);
  
  let minimumLuma = 255;
  let bestR = 0;
  let bestG = 0;
  let bestB = 0;
  const width = imageData.width;
  const data = imageData.data;
  
  // Sample pixels within a small radius of the center to find the darkest module pixel
  for (let dy = -15; dy <= 15; dy += 3) {
    for (let dx = -15; dx <= 15; dx += 3) {
      const px = centerX + dx;
      const py = centerY + dy;
      if (px >= 0 && px < width && py >= 0 && py < imageData.height) {
        const offset = (py * width + px) * 4;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luma < minimumLuma) {
          minimumLuma = luma;
          bestR = r;
          bestG = g;
          bestB = b;
        }
      }
    }
  }
  
  // If too bright, it's not a color pixel
  if (minimumLuma > 180) {
    return 'monochrome';
  }
  
  const sum = bestR + bestG + bestB || 1;
  const rn = bestR / sum;
  const gn = bestG / sum;
  const bn = bestB / sum;

  // Classify lanes using robust normalized levels
  if (rn < 0.22 && gn > 0.32 && bn > 0.35) {
    return 'cyan';
  }
  if (gn < 0.20 && rn > 0.32 && bn > 0.35) {
    return 'magenta';
  }
  if (bn < 0.18 && rn > 0.40 && gn > 0.30) {
    return 'yellow';
  }
  if (gn > 0.45 && rn < 0.25 && bn < 0.35) {
    return 'green';
  }
  
  return 'monochrome';
}

export default function Receiver({ onBackToMenu }: ReceiverProps) {
  // Device/media states
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [isCameraActive, setIsCameraActive] = useState<boolean>(true);
  const [permissionError, setPermissionError] = useState<string>('');

  // Scanning state
  const [fileId, setFileId] = useState<string>('');
  const [metadata, setMetadata] = useState<TransferMetadata | null>(null);
  const [totalChunks, setTotalChunks] = useState<number>(0);
  const [chunks, setChunks] = useState<(string | null)[]>([]);
  
  // Realtime stats
  const [stats, setStats] = useState<TransferStats>({
    chunksScanned: 0,
    totalChunks: 0,
    scannedIndices: new Set<number>(),
    startTime: null,
    endTime: null,
    duplicateCount: 0,
    currentSpeed: 0,
    errorCount: 0,
  });

  const [lastScannedFrame, setLastScannedFrame] = useState<number | null>(null);
  const [isCompleted, setIsCompleted] = useState<boolean>(false);
  const [reconstructedUrl, setReconstructedUrl] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [detectedColor, setDetectedColor] = useState<'cyan' | 'magenta' | 'yellow' | 'green' | 'monochrome'>('monochrome');
  const [qrInFrame, setQrInFrame] = useState<boolean>(false);
  const [alignmentFeedback, setAlignmentFeedback] = useState<string>('Searching...');

  const [acousticSync, setAcousticSync] = useState<boolean>(false);
  const [acousticSlot, setAcousticSlot] = useState<number | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // High performance synthesizer for frame blips and success arpeggios
  const playFeedbackSound = (type: 'success' | 'complete' | 'frame') => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      osc.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      if (type === 'frame') {
        const notes = [1350, 1650, 1950, 2250];
        const pitch = notes[Math.floor(Math.random() * notes.length)];
        osc.frequency.setValueAtTime(pitch, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.05, audioCtx.currentTime + 0.002);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.015);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.02);
      } else if (type === 'complete') {
        const chord = [293.66, 369.99, 440.00, 587.33]; // D Major (Joyful & Triumphant)
        chord.forEach((freq, idx) => {
          const oscNode = audioCtx.createOscillator();
          const gainNodeNode = audioCtx.createGain();

          oscNode.type = 'sine';
          oscNode.frequency.setValueAtTime(freq, audioCtx.currentTime + idx * 0.08);

          gainNodeNode.gain.setValueAtTime(0, audioCtx.currentTime + idx * 0.08);
          gainNodeNode.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + idx * 0.08 + 0.02);
          gainNodeNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + idx * 0.08 + 0.4);

          oscNode.connect(gainNodeNode);
          gainNodeNode.connect(audioCtx.destination);

          oscNode.start(audioCtx.currentTime + idx * 0.08);
          oscNode.stop(audioCtx.currentTime + idx * 0.08 + 0.45);
        });
      }
    } catch (e) {
      // Audio context may be restricted by security policies initially
    }
  };

  // Scanner speed calculation helper
  const speedTimerRef = useRef<NodeJS.Timeout | null>(null);
  const scannedInLastSecond = useRef<number>(0);

  // References
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanLoopRef = useRef<number | null>(null);
  const lastDetectedRef = useRef<number>(0);

  // 1. Enumerate physical cameras on mount
  useEffect(() => {
    async function initDevices() {
      try {
        // Prompt for camera access first to get actual devices listing
        const initialStream = await navigator.mediaDevices.getUserMedia({ video: true });
        initialStream.getTracks().forEach(track => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter(d => d.kind === 'videoinput');
        setCameras(videoInputs);
        
        if (videoInputs.length > 0) {
          // Default to the last device which is typically the back/main camera on mobiles
          const backCam = videoInputs.find(cam => cam.label.toLowerCase().includes('back') || cam.label.toLowerCase().includes('environment'));
          const defaultCam = backCam || videoInputs[videoInputs.length - 1];
          setSelectedCameraId(defaultCam.deviceId);
        }
      } catch (err: any) {
        console.error('Camera enumeration error: ', err);
        setPermissionError('Camera block detected. Please grant page permissions to scan QR video.');
      }
    }
    initDevices();
  }, []);

  // 2. Start/stop video element stream when selected camera or state changes
  useEffect(() => {
    let activeStream: MediaStream | null = null;

    async function startCamera() {
      if (!selectedCameraId || !isCameraActive || isCompleted) return;
      try {
        setPermissionError('');
        if (activeStream) {
          activeStream.getTracks().forEach(track => track.stop());
        }

        activeStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: selectedCameraId },
            width: { ideal: 640 },
            height: { ideal: 640 },
            facingMode: 'environment'
          }
        });

        if (videoRef.current) {
          videoRef.current.srcObject = activeStream;
          videoRef.current.setAttribute('playsinline', 'true'); // Required for iOS
          videoRef.current.play();
        }
      } catch (err: any) {
        console.error('Error opening stream: ', err);
        // Fallback constraint lock if deviceId constraint fails
        try {
          activeStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }
          });
          if (videoRef.current) {
            videoRef.current.srcObject = activeStream;
            videoRef.current.play();
          }
        } catch (fallbackErr: any) {
          setPermissionError('Failed to capture stream from the selected lens. Try choosing another.');
        }
      }
    }

    startCamera();

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [selectedCameraId, isCameraActive, isCompleted]);

  // 3. Keep running speed check
  useEffect(() => {
    speedTimerRef.current = setInterval(() => {
      setStats(prev => ({
        ...prev,
        currentSpeed: scannedInLastSecond.current,
      }));
      scannedInLastSecond.current = 0;
    }, 1000);

    return () => {
      if (speedTimerRef.current) clearInterval(speedTimerRef.current);
    };
  }, []);

  // Real-time Acoustic Modem Frequency Subcarrier Decoder
  useEffect(() => {
    let audioCtx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let micSource: MediaStreamAudioSourceNode | null = null;
    let processorInterval: NodeJS.Timeout | null = null;

    if (acousticSync && !isCompleted && isCameraActive) {
      const initAudioListen = async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          audioStreamRef.current = stream;

          audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          audioContextRef.current = audioCtx;

          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 2048;
          analyserRef.current = analyser;

          micSource = audioCtx.createMediaStreamSource(stream);
          micSource.connect(analyser);

          const bufferLength = analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          const sampleRate = audioCtx.sampleRate;

          processorInterval = setInterval(() => {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(dataArray);

            // Scan bins representing frequencies in target range [800Hz - 2400Hz]
            // resolution per bin = sampleRate / 2048
            const minBin = Math.floor(800 * 2048 / sampleRate);
            const maxBin = Math.ceil(2400 * 2048 / sampleRate);

            let maxVal = -1;
            let peakBin = -1;

            for (let i = minBin; i <= maxBin; i++) {
              if (dataArray[i] > maxVal) {
                maxVal = dataArray[i];
                peakBin = i;
              }
            }

            // Detect matching amplitude peak
            if (maxVal > 95) { // clear high-energy audio signal
              const detectedFreq = peakBin * sampleRate / 2048;
              const slot = Math.round((detectedFreq - 950) / 110);
              if (slot >= 0 && slot < 12) {
                const targetFreq = 950 + slot * 110;
                if (Math.abs(detectedFreq - targetFreq) < 50) {
                  setAcousticSlot(slot);
                }
              }
            } else {
              setAcousticSlot(null);
            }
          }, 60);

        } catch (err) {
          console.warn('Microphone synclink initialization rejected:', err);
        }
      };

      initAudioListen();
    } else {
      setAcousticSlot(null);
    }

    return () => {
      if (processorInterval) clearInterval(processorInterval);
      if (micSource) micSource.disconnect();
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (audioCtx) {
        audioCtx.close().catch(() => {});
      }
      audioContextRef.current = null;
      audioStreamRef.current = null;
      analyserRef.current = null;
    };
  }, [acousticSync, isCompleted, isCameraActive]);

  // Draw futuristic target alignment brackets and display coordinates / focal status
  const updateTargetOverlay = useCallback((
    location: {
      topLeftCorner: { x: number; y: number };
      topRightCorner: { x: number; y: number };
      bottomRightCorner: { x: number; y: number };
      bottomLeftCorner: { x: number; y: number };
    } | null,
    srcWidth: number,
    srcHeight: number
  ) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    
    // Always keep device pixel ratio dimensions accurate to prevent blurring
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.clearRect(0, 0, w, h);

    if (!location) {
      setQrInFrame(false);
      setAlignmentFeedback('Searching for QR stream...');
      return;
    }

    setQrInFrame(true);

    // Calculate dimensions of physical QR inside video stream
    const dx = location.topRightCorner.x - location.topLeftCorner.x;
    const dy = location.topRightCorner.y - location.topLeftCorner.y;
    const qrWidth = Math.sqrt(dx * dx + dy * dy);
    const density = qrWidth / srcWidth;

    let alignmentMsg = 'Aligning lens...';
    let themeColor = '#10b981'; // Default beautiful Emerald-500
    if (density < 0.22) {
      alignmentMsg = 'BRING CAMERA CLOSER (TOO FAR)';
      themeColor = '#f59e0b'; // Amber-500
    } else if (density > 0.65) {
      alignmentMsg = 'MOVE LENS SLIGHTLY BACK (TOO CLOSE)';
      themeColor = '#ef4444'; // Red-500
    } else {
      alignmentMsg = 'COOPERATIVE LINK ACTIVE (OPTIMAL DISTANCE)';
      themeColor = '#10b981'; // Emerald-500
    }

    setAlignmentFeedback(alignmentMsg);

    // Scaling ratio from offscreen source canvas pixels to DOM visible client pixels
    const scaleX = w / srcWidth;
    const scaleY = h / srcHeight;

    const points = [
      { x: location.topLeftCorner.x * scaleX, y: location.topLeftCorner.y * scaleY },
      { x: location.topRightCorner.x * scaleX, y: location.topRightCorner.y * scaleY },
      { x: location.bottomRightCorner.x * scaleX, y: location.bottomRightCorner.y * scaleY },
      { x: location.bottomLeftCorner.x * scaleX, y: location.bottomLeftCorner.y * scaleY },
    ];

    // 1. Draw elegant outer wireframe
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.lineTo(points[2].x, points[2].y);
    ctx.lineTo(points[3].x, points[3].y);
    ctx.closePath();
    ctx.stroke();

    // 2. Translucent matrix highlight
    ctx.fillStyle = `${themeColor}12`; // ~7% opacity
    ctx.fill();

    // 3. Focal corner brackets
    points.forEach((pt) => {
      ctx.fillStyle = themeColor;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4, 0, 2 * Math.PI);
      ctx.fill();
    });

    // 4. Futuristic status text
    ctx.font = '9px monospace';
    ctx.fillStyle = themeColor;
    ctx.fillText(`${alignmentMsg}`, points[0].x, points[0].y - 8);
  }, []);

  // 4. Scanning Process Loop ticking via requestAnimationFrame
  useEffect(() => {
    if (isCompleted || !isCameraActive) {
      if (scanLoopRef.current) cancelAnimationFrame(scanLoopRef.current);
      return;
    }

    const scanFrame = () => {
      try {
        if (videoRef.current && videoRef.current.readyState === videoRef.current.HAVE_CURRENT_DATA) {
          const video = videoRef.current;
          const canvas = canvasRef.current || document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          if (ctx) {
            const width = video.videoWidth;
            const height = video.videoHeight;
            canvas.width = width;
            canvas.height = height;

            // Draw current video frame onto offscreen canvas helper
            ctx.drawImage(video, 0, 0, width, height);

            // Attempt QR extract
            const imageData = ctx.getImageData(0, 0, width, height);
            const qrCode = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert',
            });

            if (qrCode && qrCode.data) {
              lastDetectedRef.current = Date.now();
              const color = detectQRColor(imageData, qrCode.location);
              setDetectedColor(color);
              handleQRData(qrCode.data);
              updateTargetOverlay(qrCode.location, width, height);
            } else {
              // Smoothly clear HUD brackets after 300ms if no QR decoded
              if (Date.now() - lastDetectedRef.current > 300) {
                updateTargetOverlay(null, 0, 0);
              }
            }
          }
        }
      } catch (err) {
        console.error('Canvas processing tick failure:', err);
      }
      
      // Schedule next tick
      scanLoopRef.current = requestAnimationFrame(scanFrame);
    };

    scanLoopRef.current = requestAnimationFrame(scanFrame);

    return () => {
      if (scanLoopRef.current) cancelAnimationFrame(scanLoopRef.current);
    };
  }, [fileId, totalChunks, chunks, isCompleted, isCameraActive]);

  // 5. Parse and store individual decoded QR frame payloads
  const handleQRData = (rawText: string) => {
    // Expected Protocol: QFS:{fileId}:{chunkIndex}:{totalChunks}:{base64Payload}
    if (!rawText.startsWith('QFS:')) return;

    const regex = /^QFS:([A-Za-z0-9]+):(\d+):(\d+):(.+)$/s;
    const match = rawText.match(regex);
    if (!match) return;

    const [_, incomingFileId, indexStr, totalStr, payload] = match;
    const index = parseInt(indexStr);
    const total = parseInt(totalStr);

    // Speed calculation
    scannedInLastSecond.current = Math.min(scannedInLastSecond.current + 1, 30);

    // Session Switcher: If new fileID is received, reset or initialize
    if (incomingFileId !== fileId) {
      setFileId(incomingFileId);
      setTotalChunks(total);
      setMetadata(null);
      setLastScannedFrame(index);
      
      const newChunksArray = new Array(total).fill(null);
      newChunksArray[index] = payload;
      setChunks(newChunksArray);

      setStats({
        chunksScanned: 1,
        totalChunks: total,
        scannedIndices: new Set([index]),
        startTime: Date.now(),
        endTime: null,
        duplicateCount: 0,
        currentSpeed: 1,
        errorCount: 0,
      });

      // If chunk 0 is metadata, decode instantly
      if (index === 0) {
        try {
          const parsedMeta: TransferMetadata = JSON.parse(atob(payload));
          setMetadata(parsedMeta);
        } catch {
          console.error('Failed to parse metadata chunk at init');
        }
      }
      return;
    }

    // Checking duplicates within the persistent active session
    if (chunks[index] !== null) {
      setStats(prev => ({
        ...prev,
        duplicateCount: prev.duplicateCount + 1,
      }));
      try {
        const syncChannel = new BroadcastChannel('qfs-sync-channel');
        syncChannel.postMessage({
          type: 'SCAN_UPDATE',
          fileId: incomingFileId,
          index: index,
          isDuplicate: true,
          timestamp: Date.now()
        });
        syncChannel.close();
      } catch (e) {}
      return;
    }

    // Save newly parsed file block
    setLastScannedFrame(index);
    const updatedChunks = [...chunks];
    updatedChunks[index] = payload;
    setChunks(updatedChunks);

    try {
      const syncChannel = new BroadcastChannel('qfs-sync-channel');
      syncChannel.postMessage({
        type: 'SCAN_UPDATE',
        fileId: incomingFileId,
        index: index,
        isDuplicate: false,
        timestamp: Date.now()
      });
      syncChannel.close();
    } catch (e) {}

    if (acousticSync) {
      playFeedbackSound('frame');
    }

    // Save stats
    const updatedIndices = new Set(stats.scannedIndices);
    updatedIndices.add(index);
    
    setStats(prev => ({
      ...prev,
      chunksScanned: updatedIndices.size,
      scannedIndices: updatedIndices,
    }));

    // Perform metadata decode on-demand if missing
    if (index === 0 && !metadata) {
      try {
        const parsedMeta: TransferMetadata = JSON.parse(atob(payload));
        setMetadata(parsedMeta);
      } catch (err) {
        console.error('Metadata decode parsing error:', err);
      }
    }

    // Verify Completion Constraint
    // All indices from 0 to total-1 must be scanned
    const fullyAssembled = updatedChunks.every(c => c !== null);
    if (fullyAssembled) {
      if (acousticSync) {
        playFeedbackSound('complete');
      }
      assembleAndReconstruct(updatedChunks, metadata);
    }
  };

  // 6. Assemble chunks, decode base64, run native Gzip decompression to construct original file
  const assembleAndReconstruct = async (finalChunks: (string | null)[], currentMeta: TransferMetadata | null) => {
    if (scanLoopRef.current) cancelAnimationFrame(scanLoopRef.current);
    setIsCompleted(true);
    setIsCameraActive(false);

    try {
      // 1. Extract and confirm metadata
      let fileMeta = currentMeta;
      if (!fileMeta && finalChunks[0]) {
        try {
          fileMeta = JSON.parse(atob(finalChunks[0]));
        } catch {
          throw new Error('Failed to parse file header metadata frame.');
        }
      }

      if (!fileMeta) {
        throw new Error('All packets collected but file metadata is corrupted or missing.');
      }

      // 2. Concatenate binary file chunks starting from frame 1
      let compressedBytes: Uint8Array;

      if (fileMeta?.differential) {
        // Differential recovery mode: decode blocks from base64 first
        const blockBytesList: Uint8Array[] = [];
        for (let i = 1; i < finalChunks.length; i++) {
          if (!finalChunks[i]) {
            throw new Error(`Data corruption: block ${i} is missing during reassembly.`);
          }
          blockBytesList.push(base64ToBytes(finalChunks[i]!));
        }

        // Apply XOR reverse delta propagation
        const reconstructedBlocks: Uint8Array[] = [];
        if (blockBytesList.length > 0) {
          reconstructedBlocks.push(blockBytesList[0]);
        }

        for (let i = 1; i < blockBytesList.length; i++) {
          const deltaBlock = blockBytesList[i];
          const prevBlock = reconstructedBlocks[i - 1];
          const len = deltaBlock.length;
          const reconstructed = new Uint8Array(len);

          for (let j = 0; j < len; j++) {
            reconstructed[j] = deltaBlock[j] ^ (prevBlock[j] || 0);
          }
          reconstructedBlocks.push(reconstructed);
        }

        // Concatenate blocks
        const totalLen = reconstructedBlocks.reduce((acc, b) => acc + b.length, 0);
        compressedBytes = new Uint8Array(totalLen);
        let offset = 0;
        for (const block of reconstructedBlocks) {
          compressedBytes.set(block, offset);
          offset += block.length;
        }
      } else {
        // Standard absolute reconstruction
        const payloadChunks = finalChunks.slice(1) as string[];
        const fullBase64 = payloadChunks.join('');
        compressedBytes = base64ToBytes(fullBase64);
      }

      // 4. Decompress GZIP bytes natively
      const originalBytes = await decompressBytes(compressedBytes);

      // 5. Generate downloadable browser blob
      const fileBlob = new Blob([originalBytes], { type: fileMeta.type || 'application/octet-stream' });
      const completedBlobUrl = URL.createObjectURL(fileBlob);
      
      setReconstructedUrl(completedBlobUrl);
      setStats(prev => ({ ...prev, endTime: Date.now() }));

      // Trigger automatic background browser download for ultimate convenience!
      const triggerLink = document.createElement('a');
      triggerLink.href = completedBlobUrl;
      triggerLink.download = fileMeta.name;
      document.body.appendChild(triggerLink);
      triggerLink.click();
      document.body.removeChild(triggerLink);
    } catch (err: any) {
      console.error('File assembly failure:', err);
      setErrorMessage(err.message || 'Verification checksum failed. Unzipped payload might be broken.');
    }
  };

  // Manual reset to start fresh
  const handleResetScanner = () => {
    if (reconstructedUrl) {
      URL.revokeObjectURL(reconstructedUrl);
    }
    setFileId('');
    setMetadata(null);
    setTotalChunks(0);
    setChunks([]);
    setIsCompleted(false);
    setIsCameraActive(true);
    setReconstructedUrl('');
    setErrorMessage('');
    setDetectedColor('monochrome');
    setAcousticSlot(null);
    setLastScannedFrame(null);
    setStats({
      chunksScanned: 0,
      totalChunks: 0,
      scannedIndices: new Set<number>(),
      startTime: null,
      endTime: null,
      duplicateCount: 0,
      currentSpeed: 0,
      errorCount: 0,
    });
  };

  const formattedSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getPercentage = () => {
    if (!totalChunks) return 0;
    return Math.round((stats.chunksScanned / totalChunks) * 100);
  };

  return (
    <div className="w-full max-w-xl mx-auto bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl relative overflow-hidden" id="receiver-card">
      {/* Background Accent Gradients */}
      <div className="absolute -top-10 -left-10 w-40 h-40 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>

      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-slate-800/80 mb-6 relative z-10">
        <div>
          <h2 className="text-xl font-bold font-sans tracking-tight text-white flex items-center gap-2">
            <Camera className="text-emerald-400 w-5 h-5 animate-pulse" />
            Scanner Mode
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">Collect and decompress frames</p>
        </div>
        <button
          onClick={onBackToMenu}
          className="px-3 py-1.5 rounded-xl border border-slate-800 bg-slate-900/60 hover:bg-slate-800 text-slate-300 hover:text-white transition-all text-xs font-semibold"
          id="btn-back-menu-rx"
        >
          Back To Menu
        </button>
      </div>

      {/* Settings & Hardware Control Panel */}
      {!isCompleted && (
        <div className="bg-slate-950 p-4 rounded-2xl border border-slate-850 mb-4 space-y-3 relative z-10">
          <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
            {/* Camera Select (Only show if multiple exist, otherwise show generic camera active text) */}
            <div className="flex items-center justify-between flex-1 gap-2">
              <label className="text-xs font-bold text-slate-350 flex items-center gap-1.5 select-none shrink-0">
                <Video className="w-3.5 h-3.5 text-indigo-400" />
                Lens Input:
              </label>
              {cameras.length > 1 ? (
                <select
                  value={selectedCameraId}
                  onChange={(e) => setSelectedCameraId(e.target.value)}
                  className="bg-slate-900 border border-slate-800 text-xs text-slate-200 rounded-lg py-1 px-2 outline-none focus:border-indigo-500 max-w-[180px] sm:max-w-[200px]"
                  id="camera-select-dropdown"
                >
                  {cameras.map((cam, i) => (
                    <option key={cam.deviceId || i} value={cam.deviceId}>
                      {cam.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[11px] font-mono font-bold text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                  Primary Optical Lens
                </span>
              )}
            </div>

            {/* Separator on desktop */}
            <div className="hidden sm:block w-px h-5 bg-slate-800"></div>

            {/* Sonic Sync Assistant Control */}
            <div className="flex items-center justify-between gap-1">
              <label className="text-xs font-bold text-slate-350 flex items-center gap-1 select-none shrink-0 sm:mr-1">
                <span className="group relative flex items-center gap-1">
                  <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                  Sonic Sync:
                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-slate-900 text-[10px] text-slate-300 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-slate-800 shadow-xl leading-relaxed z-50">
                    Listens via microphone for high-frequency coordinate beeps to synchronize frame indexes reliably!
                  </span>
                </span>
              </label>
              <div className="flex bg-slate-900 p-0.5 rounded-lg border border-slate-800" id="rx-acoustic-toggle-grid">
                <button
                  type="button"
                  onClick={() => setAcousticSync(false)}
                  className={`px-2 py-1 text-[10px] rounded font-bold transition-all ${
                    !acousticSync ? 'bg-slate-800 text-slate-300' : 'text-slate-500 hover:text-slate-350'
                  }`}
                >
                  Mute
                </button>
                <button
                  type="button"
                  onClick={() => setAcousticSync(true)}
                  className={`px-2 py-1 text-[10px] rounded font-bold transition-all flex items-center gap-1 ${
                    acousticSync ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20 shadow-inner' : 'text-slate-500 hover:text-slate-350'
                  }`}
                >
                  Listen
                </button>
              </div>
            </div>
          </div>
          
          {/* Real-time mic indicator if active */}
          {acousticSync && (
            <div className="h-[2px] bg-slate-900 rounded-full overflow-hidden relative">
              <div className={`h-full bg-amber-400 ${acousticSlot !== null ? 'w-full scale-x-100' : 'w-1/3 scale-x-50 animate-pulse'} origin-left transition-all duration-150`}></div>
            </div>
          )}
        </div>
      )}

      {/* Main viewport Container */}
      <div className="relative z-10 space-y-6">
        {permissionError && (
          <div className="bg-rose-500/15 border border-rose-500/30 text-rose-300 p-4 rounded-2xl flex items-start gap-2.5 text-xs">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">Camera Blocked or Not Found</p>
              <p className="mt-0.5 text-rose-400/80 leading-relaxed">{permissionError}</p>
            </div>
          </div>
        )}

        {/* Viewport states */}
        {!isCompleted ? (
          <div>
            {/* Live Camera Feed inside stylized scanning frame */}
            <div className="relative aspect-video rounded-3xl overflow-hidden bg-slate-950 border border-slate-800 shadow-inner group">
              <video
                ref={videoRef}
                className="w-full h-full object-cover select-none"
                id="camera-feed-video"
                playsInline
                muted
              />

              <canvas
                ref={overlayCanvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none z-10 object-cover"
              />

              {/* Holographic targeting outline frames */}
              <div className="absolute inset-4 border border-dashed border-emerald-400/20 rounded-2xl pointer-events-none flex items-center justify-center">
                <div className="w-48 h-48 border-2 border-emerald-400/40 rounded-2xl relative">
                  {/* Glowing bracket corners */}
                  <div className="absolute -top-1 -left-1 w-5 h-5 border-t-4 border-l-4 border-emerald-400 rounded-tl-md"></div>
                  <div className="absolute -top-1 -right-1 w-5 h-5 border-t-4 border-r-4 border-emerald-400 rounded-tr-md"></div>
                  <div className="absolute -bottom-1 -left-1 w-5 h-5 border-b-4 border-l-4 border-emerald-400 rounded-bl-md"></div>
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 border-b-4 border-r-4 border-emerald-400 rounded-br-md"></div>
                </div>
              </div>

              {/* Glowing horizontal laser sweep line */}
              {isCameraActive && (
                <div className="absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent top-0 animate-swipe-laser pointer-events-none shadow-[0_0_12px_rgba(52,211,153,0.8)]"></div>
              )}

              {/* Status banner Overlay inside camera feed */}
              <div className="absolute bottom-3 left-3 right-3 bg-slate-950/80 backdrop-blur border border-slate-800 p-2 py-2.5 rounded-xl flex items-center justify-between text-[11px] font-medium text-slate-300">
                <div className="flex items-center gap-1.5 pl-1">
                  <span className={`w-2 h-2 rounded-full ${isCameraActive ? (qrInFrame ? 'bg-emerald-400' : 'bg-emerald-500 animate-pulse') : 'bg-rose-500'} block`}></span>
                  <span className="font-semibold uppercase tracking-wider text-[10px]">
                    {qrInFrame ? (
                      <span className="text-emerald-400 font-bold">{alignmentFeedback}</span>
                    ) : (
                      <span>{isCameraActive ? 'Searching Lens Signal...' : 'Scanning paused'}</span>
                    )}
                  </span>
                </div>
                {detectedColor !== 'monochrome' && (
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-900 border border-slate-800 text-[10px] font-bold tracking-wider uppercase">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      detectedColor === 'cyan' ? 'bg-cyan-400' :
                      detectedColor === 'magenta' ? 'bg-pink-500' :
                      detectedColor === 'yellow' ? 'bg-yellow-400' : 'bg-emerald-400'
                    } animate-pulse`}></span>
                    <span className={
                      detectedColor === 'cyan' ? 'text-cyan-400' :
                      detectedColor === 'magenta' ? 'text-pink-500' :
                      detectedColor === 'yellow' ? 'text-yellow-400' : 'text-emerald-400'
                    }>
                      {detectedColor} lane
                    </span>
                  </span>
                )}
                {fileId && (
                  <span className="font-mono bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/20 shrink-0 select-none">
                    Session: {fileId}
                  </span>
                )}
              </div>
            </div>

            {/* Active Progress indicators */}
            {totalChunks > 0 && (
              <div className="mt-6 space-y-4">
                <div className="bg-slate-950 border border-slate-850 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className="text-slate-400 flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-indigo-400" />
                      Scanner Assembly Progress
                    </span>
                    <span className="text-emerald-400 font-mono font-bold text-right">
                      {getPercentage()}% ({stats.chunksScanned} / {totalChunks} frames)
                    </span>
                  </div>

                  {/* Standard horizontal progress loading bar */}
                  <div className="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-300"
                      style={{ width: `${getPercentage()}%` }}
                    ></div>
                  </div>

                  {/* Transfer realtime status metadata details */}
                  <div className="h-px bg-slate-850/80 my-1"></div>
                  <div className="grid grid-cols-2 gap-y-1.5 text-[11px]">
                    <span className="text-slate-500">File Identified:</span>
                    <span className="text-slate-200 font-medium text-right truncate">
                      {metadata ? metadata.name : 'Awaiting packet 0 (Metadata)...'}
                    </span>

                    <span className="text-slate-500">Type / Real Size:</span>
                    <span className="text-slate-300 text-right font-light">
                      {metadata ? `${metadata.type} (${formattedSize(metadata.size)})` : 'Calculating...'}
                    </span>

                    <span className="text-slate-500">Decoding Speed Feed:</span>
                    <span className="text-emerald-400 font-bold font-mono text-right">
                      {stats.currentSpeed} unique fr/s
                    </span>

                    <span className="text-slate-500">Duplicate Scans Avoided:</span>
                    <span className="text-amber-500 font-mono text-right">
                      {stats.duplicateCount} frames
                    </span>

                    <span className="text-slate-500">Spectral Stream Profile:</span>
                    <span className="text-right font-bold text-xs uppercase">
                      {detectedColor !== 'monochrome' ? (
                        <span className={`text-[10px] font-mono tracking-wider ${
                          detectedColor === 'cyan' ? 'text-cyan-400' :
                          detectedColor === 'magenta' ? 'text-pink-500' :
                          detectedColor === 'yellow' ? 'text-yellow-400' : 'text-emerald-400'
                        }`}>
                          {detectedColor} Lane Active
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[10px] font-mono tracking-wider uppercase">Standard Luma (B&W)</span>
                      )}
                    </span>
                  </div>
                </div>

                {/* Chunks grid blocks visualization */}
                <div className="space-y-1 text-left">
                  <span className="text-[10px] font-bold text-slate-550 uppercase tracking-widest pl-1">
                    Assembly Slots Matrix ({stats.chunksScanned} / {totalChunks})
                  </span>
                  <div className="bg-slate-950 p-3.5 rounded-2xl border border-slate-850 flex flex-wrap gap-1.5 justify-start max-h-32 overflow-y-auto custom-scroll">
                    {chunks.map((chunk, i) => {
                      const isScanned = chunk !== null;
                      const isActive = lastScannedFrame === i;
                      const isMeta = i === 0;

                      return (
                        <div
                          key={i}
                          className={`w-4 h-4 rounded-md flex items-center justify-center text-[8.5px] font-mono font-bold select-none transition-all duration-300 ${
                            isActive
                              ? 'bg-indigo-500 text-white ring-2 ring-indigo-400 scale-110 shadow-lg shadow-indigo-600/30'
                              : isScanned
                              ? 'bg-emerald-500 border border-emerald-450 text-emerald-950'
                              : isMeta
                              ? 'bg-slate-900 border border-amber-500/20 text-amber-500/40 hover:border-amber-500/40'
                              : 'bg-slate-900 border border-slate-805 text-slate-600 hover:border-slate-700'
                          }`}
                          title={isMeta ? 'Metadata frame [0]' : `Payload frame [${i}]: ${isScanned ? 'scanned' : 'empty'}`}
                        >
                          {i}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Step 3: Reconstruction / Download View */
          <div className="bg-slate-950 border border-emerald-950 rounded-2xl p-6 text-center space-y-6 transition-all animate-fade-in relative z-10 select-none">
            {/* Completion icon container */}
            <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto border-2 border-emerald-400">
              <CheckCircle className="w-8 h-8 text-emerald-400" />
            </div>

            <div>
              <h3 className="text-lg font-bold text-white">Reassembly Successful!</h3>
              <p className="text-slate-400 text-xs mt-1">100% of packets collected. Decompression complete.</p>
            </div>

            {/* Reconstructed file card info */}
            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 text-left flex items-start gap-3">
              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 text-emerald-400">
                <FileCheck className="w-6 h-6" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-100 truncate">{metadata?.name}</p>
                <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wide font-mono">
                  {metadata?.type || 'binary/stream'} • {metadata ? formattedSize(metadata.size) : '0 bytes'}
                </p>
                {stats.startTime && stats.endTime && (
                  <p className="text-[10px] text-slate-500 mt-1">
                    Transfer duration: {((stats.endTime - stats.startTime) / 1000).toFixed(1)} seconds
                  </p>
                )}
              </div>
            </div>

            {errorMessage && (
              <div className="bg-rose-500/10 border border-rose-500/20 p-3 rounded-lg flex items-center gap-2 text-left text-xs text-rose-300">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <p>{errorMessage}</p>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col gap-3">
              <a
                href={reconstructedUrl}
                download={metadata?.name || 'reconstructed_file'}
                className="py-3 px-6 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-650 text-slate-950 font-bold rounded-xl shadow-lg shadow-emerald-500/10 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                id="btn-reconstructed-download"
              >
                <Download className="w-5 h-5" />
                Download Reassembled File
              </a>

              <button
                onClick={handleResetScanner}
                className="w-full py-2.5 border border-slate-800 hover:border-slate-700 bg-slate-900/60 hover:bg-slate-800 rounded-xl text-slate-300 hover:text-white text-xs font-semibold flex items-center justify-center gap-2 transition-all"
                id="reset-rx"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Scan Another QR Video
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
