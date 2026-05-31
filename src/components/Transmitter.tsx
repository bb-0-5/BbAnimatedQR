import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { Play, Pause, SkipForward, SkipBack, FileUp, HelpCircle, RefreshCw, Zap, Download, Layers, Volume2, VolumeX, Activity, Radio } from 'lucide-react';
import { compressBytes, bytesToBase64, generateFileId } from '../utils/compressor';

interface TransmitterProps {
  onBackToMenu: () => void;
}

export default function Transmitter({ onBackToMenu }: TransmitterProps) {
  // Input settings
  const [file, setFile] = useState<File | null>(null);
  const [manualText, setManualText] = useState<string>('');
  const [isTextMode, setIsTextMode] = useState<boolean>(false);
  const [dragActive, setDragActive] = useState<boolean>(false);

  // Transmission settings
  const [fileId, setFileId] = useState<string>('');
  const [chunkSize, setChunkSize] = useState<number>(350); // Easiest capacity balance for smartphone focus
  const [fps, setFps] = useState<number>(8); // Safe default for low-tier receiver phone cpu decodes
  const [errorCorrection, setErrorCorrection] = useState<'L' | 'M' | 'H'>('L');
  const [colorMode, setColorMode] = useState<'monochrome' | 'chromatic'>('monochrome');

  // Multi-frame playback state
  const [chunks, setChunks] = useState<string[]>([]);
  const [activeFrame, setActiveFrame] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isPrepared, setIsPrepared] = useState<boolean>(false);
  const [compressPercent, setCompressPercent] = useState<number>(100);
  const [originalSize, setOriginalSize] = useState<number>(0);
  const [compressedSize, setCompressedSize] = useState<number>(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const [acousticSync, setAcousticSync] = useState<boolean>(false);
  const [differentialMode, setDifferentialMode] = useState<boolean>(true);

  // Adaptive Performance Controller states
  const [adaptiveFps, setAdaptiveFps] = useState<boolean>(true);
  const [receiverActive, setReceiverActive] = useState<boolean>(false);
  const [lastReceiverReport, setLastReceiverReport] = useState<number>(0);
  const [adaptiveLog, setAdaptiveLog] = useState<string>('Standby (Awaiting link...)');
  const [sonicBackchannel, setSonicBackchannel] = useState<boolean>(false);

  const lastDecodeTimeRef = useRef<number[]>([]);
  const duplicateCountInWindowRef = useRef<number>(0);
  const totalDecodesInWindowRef = useRef<number>(0);
  const lastAcousticBeepTimeRef = useRef<number>(0);

  // Local browser loopback feedback over BroadcastChannel
  useEffect(() => {
    try {
      const syncChannel = new BroadcastChannel('qfs-sync-channel');
      
      syncChannel.onmessage = (event) => {
        if (!isPrepared || !isPlaying) return;
        
        const data = event.data;
        if (data && data.fileId === fileId) {
          const now = Date.now();
          setLastReceiverReport(now);
          setReceiverActive(true);
          
          if (data.type === 'SCAN_UPDATE') {
            totalDecodesInWindowRef.current += 1;
            if (data.isDuplicate) {
              duplicateCountInWindowRef.current += 1;
            } else {
              lastDecodeTimeRef.current.push(now);
            }
          }
        }
      };
      
      return () => {
        syncChannel.close();
      };
    } catch (e) {
      console.warn('BroadcastChannel not supported:', e);
    }
  }, [isPrepared, isPlaying, fileId]);

  // Real-time Sonic Backchannel Listener (listening to feedback tones from receiver)
  useEffect(() => {
    let audioCtx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let micSource: MediaStreamAudioSourceNode | null = null;
    let listenInterval: NodeJS.Timeout | null = null;

    if (sonicBackchannel && isPrepared && isPlaying) {
      const startListening = async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          
          micSource = audioCtx.createMediaStreamSource(stream);
          micSource.connect(analyser);
          
          const bufferLength = analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          const sampleRate = audioCtx.sampleRate;

          listenInterval = setInterval(() => {
            if (!analyser) return;
            analyser.getByteFrequencyData(dataArray);

            // The receiver plays feedback tones around frequencies [1350, 1650, 1950, 2250] Hz.
            // Let's detect clear energy spikes in the range [1200 - 2400] Hz.
            const minBin = Math.floor(1200 * 1024 / sampleRate);
            const maxBin = Math.ceil(2400 * 1024 / sampleRate);

            let maxVal = -1;
            for (let i = minBin; i <= maxBin; i++) {
              if (dataArray[i] > maxVal) {
                maxVal = dataArray[i];
              }
            }

            // High noise gate threshold (above 115) to represent a distinct beep
            if (maxVal > 115) {
              const now = Date.now();
              // Prevent multiple counts from a single continuous beep (beeps are ~20ms, so 150ms lock is safe)
              if (now - lastAcousticBeepTimeRef.current > 150) {
                lastAcousticBeepTimeRef.current = now;
                setLastReceiverReport(now);
                setReceiverActive(true);
                lastDecodeTimeRef.current.push(now);
              }
            }
          }, 45);

        } catch (err) {
          console.warn('Sonic backchannel microphone access rejected:', err);
          setSonicBackchannel(false);
        }
      };

      startListening();
    }

    return () => {
      if (listenInterval) clearInterval(listenInterval);
      if (micSource) micSource.disconnect();
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (audioCtx) {
        audioCtx.close().catch(() => {});
      }
    };
  }, [sonicBackchannel, isPrepared, isPlaying]);

  // Adaptive FPS Controller Processing Loop
  useEffect(() => {
    if (!isPlaying || !isPrepared || !adaptiveFps) return;

    const interval = setInterval(() => {
      const now = Date.now();
      
      // Clean up decode timestamps older than 1.5 seconds (to allow window buffer time)
      lastDecodeTimeRef.current = lastDecodeTimeRef.current.filter(t => now - t < 1500);
      
      const uniqueDecodedInPeriod = lastDecodeTimeRef.current.length;
      // Normalise to 1 second decodes rate
      const uniqueSpeed = Math.round(uniqueDecodedInPeriod / 1.5);
      const duplicates = duplicateCountInWindowRef.current;
      
      // Reset window stats
      duplicateCountInWindowRef.current = 0;
      totalDecodesInWindowRef.current = 0;

      const isLinked = now - lastReceiverReport < 4000;
      setReceiverActive(isLinked);

      if (isLinked) {
        // We have active performance feedback from the receiver device
        if (duplicates > 4 || (uniqueSpeed < fps * 0.4 && fps > 6)) {
          // Hardware/camera choking! Slow down to allow the receiver sensor to stabilize
          const nextFps = Math.max(fps - 2, 5);
          if (nextFps !== fps) {
            setFps(nextFps);
            setAdaptiveLog(`Slowing to ${nextFps} FPS (Heavy framing drops)`);
          }
        } else if (uniqueSpeed >= fps - 1 || uniqueSpeed >= 8) {
          // Cruising flawlessly! Step up speed aggressively to minimize transfer time
          const nextFps = Math.min(fps + 1, 15);
          if (nextFps !== fps) {
            setFps(nextFps);
            setAdaptiveLog(`Cruising at high-speed ${nextFps} FPS!`);
          }
        } else {
          setAdaptiveLog(`Sustaining comfortable ${fps} FPS`);
        }
      } else {
        setAdaptiveLog('Sensing scanning pace... (Awaiting link)');
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isPlaying, isPrepared, adaptiveFps, fps, lastReceiverReport]);

  // Play highly responsive electronic modem coordinate tones
  const playToneForFrame = (frameIndex: number, total: number) => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      // Map frame indexes to 12 target acoustic channels (Frequencies safe for tiny phone speakers)
      const slot = frameIndex % 12;
      const frequency = 950 + slot * 110; // 950Hz to 2160Hz spectral separation grid

      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);

      // Super snappy acoustic pulse envelope to keep it fast, clicking, and delightful to listen to
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.005); // clear but polite volume
      gainNode.gain.setValueAtTime(0.08, ctx.currentTime + 0.03);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.045);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.05);
    } catch (err) {
      console.warn('Acoustic synthesis block:', err);
    }
  };

  // Drag handers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
    }
  };

  // Build the transfer chunks
  const prepareTransfer = async () => {
    try {
      let rawData: Uint8Array;
      let name: string;
      let type: string;

      if (isTextMode) {
        if (!manualText.trim()) return;
        rawData = new TextEncoder().encode(manualText);
        name = 'text-memo.txt';
        type = 'text/plain';
      } else {
        if (!file) return;
        rawData = new Uint8Array(await file.arrayBuffer());
        name = file.name;
        type = file.type || 'application/octet-stream';
      }

      setOriginalSize(rawData.length);

      // 1. Compress
      const compressed = await compressBytes(rawData);
      setCompressedSize(compressed.length);
      setCompressPercent(Math.round((compressed.length / rawData.length) * 100) || 1);

      // 2. Base64 or Byte Delta Partitioning based on Mode
      const dataChunks: string[] = [];

      if (differentialMode) {
        // Splitting into raw byte chunks to perform byte-level XOR (Low-Entropy Transitions)
        const byteChunkSize = Math.floor(chunkSize * 0.73);
        const rawByteChunks: Uint8Array[] = [];
        for (let i = 0; i < compressed.length; i += byteChunkSize) {
          rawByteChunks.push(compressed.subarray(i, i + byteChunkSize));
        }

        if (rawByteChunks.length > 0) {
          // Chunk 1 is absolute
          dataChunks.push(bytesToBase64(rawByteChunks[0]));
        }

        // Subsequent chunks are XOR with previous raw byte block
        for (let i = 1; i < rawByteChunks.length; i++) {
          const prev = rawByteChunks[i - 1];
          const curr = rawByteChunks[i];
          const len = curr.length;
          const delta = new Uint8Array(len);
          for (let j = 0; j < len; j++) {
            delta[j] = curr[j] ^ (prev[j] || 0);
          }
          dataChunks.push(bytesToBase64(delta));
        }
      } else {
        // Standard high-entropy absolute Base64 chunking
        const b64Data = bytesToBase64(compressed);
        for (let i = 0; i < b64Data.length; i += chunkSize) {
          dataChunks.push(b64Data.slice(i, i + chunkSize));
        }
      }

      // 3. Generate metadata. Chunk index 0 is always metadata.
      const metadataPayload = {
        name,
        type,
        size: rawData.length,
        differential: differentialMode,
      };
      const metadataB64 = btoa(JSON.stringify(metadataPayload));

      // 5. Construct QR-safe headers
      // QFS:{fileId}:{chunkIndex}:{totalChunks}:{payload}
      const newFileId = generateFileId();
      setFileId(newFileId);

      const totalChunks = dataChunks.length + 1; // +1 for the metadata chunk
      const fullFrames: string[] = [];

      // Frame 0: Metadata
      fullFrames.push(`QFS:${newFileId}:0:${totalChunks}:${metadataB64}`);

      // Frames 1..N: Data
      dataChunks.forEach((chunk, index) => {
        fullFrames.push(`QFS:${newFileId}:${index + 1}:${totalChunks}:${chunk}`);
      });

      setChunks(fullFrames);
      setActiveFrame(0);
      setIsPrepared(true);
      setIsPlaying(true);
    } catch (e) {
      console.error(e);
      alert('Error compressing or packaging file.');
    }
  };

  // Reset state to select another file
  const handleReset = () => {
    setIsPrepared(false);
    setIsPlaying(false);
    setChunks([]);
    setActiveFrame(0);
    setReceiverActive(false);
    setAdaptiveLog('Standby (Awaiting link...)');
  };

  // Frame Playback Engine (Precise tick timer relying on state refresh)
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);

    if (isPlaying && chunks.length > 1) {
      const ms = Math.round(1000 / fps);
      timerRef.current = setInterval(() => {
        setActiveFrame((prev) => (prev + 1) % chunks.length);
      }, ms);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPlaying, chunks, fps]);

  // Render the current frame QR vector to the canvas
  useEffect(() => {
    if (isPrepared && chunks[activeFrame] && canvasRef.current) {
      let qrDarkColor = '#1e293b'; // Default Deep Slate
      
      if (colorMode === 'chromatic') {
        const lane = activeFrame % 4;
        if (lane === 0) qrDarkColor = '#0891b2';      // Cyan (Optical High-Contrast)
        else if (lane === 1) qrDarkColor = '#c026d3'; // Magenta (Optical High-Contrast)
        else if (lane === 2) qrDarkColor = '#ca8a04'; // Yellow (Optical High-Contrast)
        else qrDarkColor = '#16a34a';                 // Green (Optical High-Contrast)
      }

      QRCode.toCanvas(
        canvasRef.current,
        chunks[activeFrame],
        {
          margin: 1,
          width: 320,
          color: {
            dark: qrDarkColor,
            light: '#ffffff',
          },
          errorCorrectionLevel: errorCorrection,
        },
        (error) => {
          if (error) console.error('QR Render Error: ', error);
        }
      );
    }
  }, [activeFrame, chunks, isPrepared, errorCorrection, colorMode]);

  // Emit acoustic sync tone on frame changes
  useEffect(() => {
    if (isPrepared && isPlaying && acousticSync && chunks.length > 0) {
      playToneForFrame(activeFrame, chunks.length);
    }
  }, [activeFrame, isPrepared, isPlaying, acousticSync, chunks.length]);

  const handleNext = () => {
    if (chunks.length > 0) {
      setActiveFrame((prev) => (prev + 1) % chunks.length);
    }
  };

  const handlePrev = () => {
    if (chunks.length > 0) {
      setActiveFrame((prev) => (prev - 1 + chunks.length) % chunks.length);
    }
  };

  const formattedSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="w-full max-w-xl mx-auto bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl relative overflow-hidden" id="transmitter-card">
      {/* Visual Background Accent Glows */}
      <div className="absolute -top-10 -right-10 w-40 h-40 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-sky-500/10 rounded-full blur-3xl pointer-events-none"></div>

      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-slate-800/80 mb-6 relative z-10">
        <div>
          <h2 className="text-xl font-bold font-sans tracking-tight text-white flex items-center gap-2">
            <Zap className="text-indigo-400 w-5 h-5 animate-pulse" />
            Transmitter Mode
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">Encode files into scanning packets</p>
        </div>
        <button
          onClick={onBackToMenu}
          className="px-3 py-1.5 rounded-xl border border-slate-800 bg-slate-900/60 hover:bg-slate-800 text-slate-300 hover:text-white transition-all text-xs font-semibold"
          id="btn-back-menu-tx"
        >
          Back To Menu
        </button>
      </div>

      {/* Step 1: Selection View */}
      {!isPrepared ? (
        <div className="space-y-6 relative z-10 transition-opacity duration-300">
          {/* Toggle Tab */}
          <div className="flex bg-slate-950 p-1.5 rounded-2xl border border-slate-800/60" id="tabs-input-source">
            <button
              onClick={() => setIsTextMode(false)}
              className={`flex-1 py-2 text-center rounded-xl text-sm font-semibold transition-all ${
                !isTextMode
                  ? 'bg-gradient-to-r from-indigo-600 to-indigo-700 text-white shadow-md shadow-indigo-950/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
              }`}
              id="tab-file-mode"
            >
              Share File
            </button>
            <button
              onClick={() => setIsTextMode(true)}
              className={`flex-1 py-2 text-center rounded-xl text-sm font-semibold transition-all ${
                isTextMode
                  ? 'bg-gradient-to-r from-indigo-600 to-indigo-700 text-white shadow-md shadow-indigo-950/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
              }`}
              id="tab-text-mode"
            >
              Share Text
            </button>
          </div>

          {/* Area Input */}
          {!isTextMode ? (
            <div
              className={`border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center transition-all cursor-pointer ${
                dragActive
                  ? 'border-indigo-400 bg-indigo-500/5'
                  : 'border-slate-800 hover:border-slate-700 hover:bg-slate-950/20'
              }`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-upload-input')?.click()}
              id="drag-drop-zone"
            >
              <input
                id="file-upload-input"
                type="file"
                className="hidden"
                onChange={(e) => e.target.files && setFile(e.target.files[0])}
              />
              <div className="w-12 h-12 bg-slate-950 rounded-xl flex items-center justify-center border border-slate-800/80 mb-3 group-hover:scale-105 transition-transform">
                <FileUp className="w-6 h-6 text-indigo-400" />
              </div>
              {file ? (
                <div className="text-center">
                  <p className="text-sm font-bold text-slate-100 max-w-sm cut-text mb-1">{file.name}</p>
                  <p className="text-xs text-slate-400">{formattedSize(file.size)} • {file.type || 'unknown type'}</p>
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-sm font-semibold text-slate-200">Drag & drop your file here</p>
                  <p className="text-xs text-slate-500 mt-1">Or click to browse from device</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">Enter Text Content</label>
              <textarea
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder="Type or paste text, links, code, secret keys, or messages here..."
                rows={5}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60"
                id="manual-text-input"
              />
              <div className="flex justify-between items-center text-[10px] text-slate-500">
                <span>{manualText.length} characters</span>
                <span>Estimated chunk count: {Math.ceil(manualText.length / chunkSize) || 1}</span>
              </div>
            </div>
          )}

          {/* Config Grid Panel */}
          <div className="bg-slate-950 rounded-2xl p-4 border border-slate-850 space-y-4">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-indigo-400" />
              Tune Transmission Density
            </h3>
            <div className="grid grid-cols-2 gap-4">
              {/* Chunk Size */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-slate-400 flex items-center gap-1">
                    Chunk Size
                    <span className="group relative">
                      <HelpCircle className="w-3 h-3 text-slate-600 cursor-pointer hover:text-slate-450" />
                      <span className="absolute bottom-full left-1/4 mb-2 w-48 p-2 bg-slate-900 text-[10px] text-slate-300 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-slate-800 shadow-xl leading-relaxed">
                        Data characters per QR frame. Smaller sizes (300-400) form highly legible QR structures easily read by all phone sensors.
                      </span>
                    </span>
                  </label>
                  <span className="text-xs font-mono font-medium text-indigo-400">{chunkSize} chars</span>
                </div>
                <input
                  type="range"
                  min="160"
                  max="800"
                  step="20"
                  value={chunkSize}
                  onChange={(e) => setChunkSize(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  id="range-chunk-size"
                />
              </div>

              {/* FPS Rate */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-slate-400 flex items-center gap-1">
                    Transmission Speed
                    <span className="group relative">
                      <HelpCircle className="w-3 h-3 text-slate-600 cursor-pointer" />
                      <span className="absolute bottom-full right-1/4 mb-2 w-48 p-2 bg-slate-900 text-[10px] text-slate-300 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-slate-800 shadow-xl leading-relaxed">
                        Frames Per Second. Make this slower (5-8 FPS) for older smartphone cameras to prevent skipped slots. Higher speeds (10-15 FPS) are blazing but require steady focus.
                      </span>
                    </span>
                  </label>
                  <span className="text-xs font-mono font-medium text-emerald-400">{fps} FPS</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="15"
                  step="1"
                  value={fps}
                  disabled={adaptiveFps}
                  onChange={(e) => setFps(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500 disabled:opacity-50"
                  id="range-fps"
                />
              </div>

              {/* Adaptive FPS Controller Settings Row */}
              <div className="col-span-2 space-y-2 pt-1 border-t border-slate-900/40">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400 block font-semibold flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-indigo-400" />
                    Adaptive Performance Stream
                    <span className="group relative">
                      <HelpCircle className="w-3 h-3 text-slate-600 cursor-pointer" />
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-2 bg-slate-900 text-[10px] text-slate-300 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-slate-800 shadow-xl leading-relaxed z-50">
                        Automatically measures optical scan frequency (5-15 FPS) in real-time. Scales transmission speeds up as the receiver connects, throttling down instantly if the receiver's hardware drops packets. Completely automated and responsive.
                      </span>
                    </span>
                  </span>
                  
                  {adaptiveFps && (
                    <span className="text-[9px] font-mono font-bold text-indigo-400 animate-pulse bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20 uppercase tracking-wider">
                      Dynamic tuning active
                    </span>
                  )}
                </div>
                
                <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1 rounded-xl border border-slate-805" id="adaptive-fps-selector">
                  <button
                    type="button"
                    onClick={() => setAdaptiveFps(false)}
                    className={`py-2 text-[11px] rounded-lg font-bold transition-all ${
                      !adaptiveFps
                        ? 'bg-indigo-500/15 border border-indigo-500/20 text-indigo-300'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Off (Static Rate)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdaptiveFps(true)}
                    className={`py-2 text-[11px] rounded-lg font-bold transition-all ${
                      adaptiveFps
                        ? 'bg-gradient-to-r from-indigo-500/10 to-indigo-600/15 border border-indigo-500/30 text-indigo-300 shadow-inner'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    On (Auto-Adjust Rate)
                  </button>
                </div>
              </div>

              {/* Sonic Backchannel Toggle for Transmitter */}
              {adaptiveFps && (
                <div className="col-span-2 space-y-2 pt-1.5 border-t border-slate-900/40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400 block font-semibold flex items-center gap-1.5">
                      <Radio className="w-3.5 h-3.5 text-amber-400" />
                      Sonic Backchannel
                      <span className="group relative">
                        <HelpCircle className="w-3 h-3 text-slate-600 cursor-pointer" />
                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-2 bg-slate-900 text-[10px] text-slate-300 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-slate-800 shadow-xl leading-relaxed z-50">
                          Enables the transmitter to hear the receiver device's successful decode beeps via microphone! Acts as an air-gapped acoustic modem connection to match phone hardware perfectly.
                        </span>
                      </span>
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1 rounded-xl border border-slate-805" id="sonic-backchannel-selector">
                    <button
                      type="button"
                      onClick={() => setSonicBackchannel(false)}
                      className={`py-2 text-[11px] rounded-lg font-bold transition-all ${
                        !sonicBackchannel
                          ? 'bg-indigo-500/10 border border-indigo-500/20 text-indigo-300'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      Optical Connection Only
                    </button>
                    <button
                      type="button"
                      onClick={() => setSonicBackchannel(true)}
                      className={`py-2 text-[11px] rounded-lg font-bold transition-all ${
                        sonicBackchannel
                          ? 'bg-amber-500/15 border border-amber-500/35 text-amber-300 shadow-inner'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      Acoustic Backchannel Link
                    </button>
                  </div>
                </div>
              )}

              {/* Error correction */}
              <div className="col-span-2 space-y-1.5">
                <label className="text-xs text-slate-400 block pb-1">QR Code Resilience Pattern</label>
                <div className="grid grid-cols-3 gap-2 bg-slate-900 p-1 rounded-xl border border-slate-805" id="error-correction-selector">
                  <button
                    type="button"
                    onClick={() => setErrorCorrection('L')}
                    className={`py-1.5 text-[11px] rounded-lg font-bold transition-all ${
                      errorCorrection === 'L'
                        ? 'bg-emerald-500/10 border border-emerald-400/30 text-emerald-300'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Level L (Low) - Best Size
                  </button>
                  <button
                    type="button"
                    onClick={() => setErrorCorrection('M')}
                    className={`py-1.5 text-[11px] rounded-lg font-bold transition-all ${
                      errorCorrection === 'M'
                        ? 'bg-amber-500/10 border border-amber-400/30 text-amber-300'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Level M (Medium)
                  </button>
                  <button
                    type="button"
                    onClick={() => setErrorCorrection('H')}
                    className={`py-1.5 text-[11px] rounded-lg font-bold transition-all ${
                      errorCorrection === 'H'
                        ? 'bg-rose-500/10 border border-rose-400/30 text-rose-300'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Level H (Max Protection)
                  </button>
                </div>
              </div>

              {/* Spectral Color Modulation Option */}
              <div className="col-span-2 space-y-2 pt-1 border-t border-slate-900/40">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400 block font-semibold flex items-center gap-1.5">
                    Active Modulation Color Space
                    <span className="group relative">
                      <HelpCircle className="w-3 h-3 text-slate-600 cursor-pointer" />
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-2 bg-slate-900 text-[10px] text-slate-300 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-slate-800 shadow-xl leading-relaxed">
                        Sets how the QR signal is colorized. Choosing Chromatic multiplexes data lanes visually into Cyan, Magenta, Yellow, & Green (4-Color limit) for experimental optical focus!
                      </span>
                    </span>
                  </span>
                </div>
                
                <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1 rounded-xl border border-slate-805" id="color-mode-selector">
                  <button
                    type="button"
                    onClick={() => setColorMode('monochrome')}
                    className={`py-2 text-[11px] rounded-lg font-bold transition-all ${
                      colorMode === 'monochrome'
                        ? 'bg-gradient-to-r from-indigo-505 with-purple-505 to-indigo-600/40 border border-indigo-500/30 text-indigo-200'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Standard Monochrome (Slate Black)
                  </button>
                  <button
                    type="button"
                    onClick={() => setColorMode('chromatic')}
                    className={`py-2 text-[11px] rounded-lg font-bold transition-all flex items-center justify-center gap-1.5 ${
                      colorMode === 'chromatic'
                        ? 'bg-gradient-to-r from-indigo-605 via-purple-605 to-indigo-600/45 border border-indigo-400/30 text-white shadow-inner'
                        : 'text-slate-505 hover:text-slate-305'
                    }`}
                  >
                    <span className="flex gap-0.5 items-center">
                      <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
                      <span className="w-2 h-2 rounded-full bg-magenta-400 bg-pink-500"></span>
                      <span className="w-2 h-2 rounded-full bg-yellow-400"></span>
                      <span className="w-2 h-2 rounded-full bg-green-505 bg-emerald-500"></span>
                    </span>
                    Chromatic (Cyan/Magenta/Yellow/Green)
                  </button>
                </div>
              </div>

              {/* Acoustic Modem Subcarrier Option */}
              <div className="col-span-2 space-y-2 pt-1 border-t border-slate-900/40">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400 block font-semibold flex items-center gap-1.5">
                    Sonic Sync Subcarrier
                    <span className="group relative">
                      <HelpCircle className="w-3 h-3 text-slate-600 cursor-pointer" />
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-2 bg-slate-900 text-[10px] text-slate-300 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-slate-800 shadow-xl leading-relaxed z-50">
                        Plays highly transient high-frequency chirp subcarrier tones synchronized with frame updates. The matching receiver listens to detect precise real-time transitions for ultra-accurate clocking!
                      </span>
                    </span>
                  </span>
                </div>
                
                <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1 rounded-xl border border-slate-805" id="acoustic-mode-selector">
                  <button
                    type="button"
                    onClick={() => {
                      setAcousticSync(false);
                    }}
                    className={`py-2 text-[11px] rounded-lg font-bold transition-all flex items-center justify-center gap-1.5 ${
                      !acousticSync
                        ? 'bg-indigo-500/10 border border-indigo-500/20 text-indigo-300'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    <VolumeX className="w-3.5 h-3.5 text-slate-450" />
                    Off (Silent Optical)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAcousticSync(true);
                      // Resume AudioContext if possible upon click initiation
                      if (audioContextRef.current) {
                        audioContextRef.current.resume().catch(() => {});
                      } else {
                        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
                      }
                    }}
                    className={`py-2 text-[11px] rounded-lg font-bold transition-all flex items-center justify-center gap-1.5 ${
                      acousticSync
                        ? 'bg-amber-500/10 border border-amber-500/30 text-amber-300 shadow-inner'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                    On (Sonic Sync Link)
                  </button>
                </div>
              </div>

              {/* Differential Delta Sequencing Option (No-Entropy Transitions) */}
              <div className="col-span-2 space-y-2 pt-1 border-t border-slate-900/40">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400 block font-semibold flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-emerald-400" />
                    Low-Entropy Delta Stream
                    <span className="group relative">
                      <HelpCircle className="w-3 h-3 text-slate-600 cursor-pointer" />
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-2 bg-slate-900 text-[10px] text-slate-300 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-slate-800 shadow-xl leading-relaxed z-50">
                        Tracks successive frames as XOR differentials from the preceding block. Minimizes visual module changes by up to 88%, resulting in smaller, stable, and highly legible QR frames.
                      </span>
                    </span>
                  </span>
                </div>
                
                <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1 rounded-xl border border-slate-805" id="differential-mode-selector">
                  <button
                    type="button"
                    onClick={() => setDifferentialMode(false)}
                    className={`py-2 text-[11px] rounded-lg font-bold transition-all flex items-center justify-center gap-1.5 ${
                      !differentialMode
                        ? 'bg-indigo-505 bg-indigo-500/15 border border-indigo-500/20 text-indigo-300'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Off (Absolute Blocks)
                  </button>
                  <button
                    type="button"
                    onClick={() => setDifferentialMode(true)}
                    className={`py-2 text-[11px] rounded-lg font-bold transition-all flex items-center justify-center gap-1.5 ${
                      differentialMode
                        ? 'bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 shadow-inner'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    On (Low-Entropy XOR)
                  </button>
                </div>
              </div>
            </div>
          </div>

          <button
            onClick={prepareTransfer}
            disabled={(!isTextMode && !file) || (isTextMode && !manualText.trim())}
            className="w-full py-3.5 bg-gradient-to-r from-indigo-500 via-purple-600 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed select-none text-white font-bold rounded-2xl shadow-xl shadow-indigo-950/30 hover:shadow-indigo-900/30 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
            id="prepare-tx-trigger"
          >
            <RefreshCw className="w-4 h-4" />
            Compress & Generate QR Video
          </button>
        </div>
      ) : (
        /* Step 2: Animated Loop View */
        <div className="space-y-6 text-center relative z-10 transition-opacity duration-300">
          {/* File summary details */}
          <div className="bg-slate-950 rounded-2xl p-4 border border-slate-900 text-left space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Active File ID</span>
              <span className="px-2 py-0.5 rounded-md bg-indigo-500/15 border border-indigo-500/20 text-xs font-mono font-bold text-indigo-400">
                {fileId}
              </span>
            </div>
            <div className="h-px bg-slate-850 my-1"></div>
            <div className="grid grid-cols-2 gap-y-1 text-xs">
              <span className="text-slate-500">Name:</span>
              <span className="text-slate-300 font-medium truncate text-right">
                {isTextMode ? 'text-memo.txt' : file?.name}
              </span>

              <span className="text-slate-500">Compression:</span>
              <span className="text-emerald-400 font-semibold text-right">
                {formattedSize(originalSize)} → {formattedSize(compressedSize)} ({compressPercent}% size)
              </span>

              <span className="text-slate-500">Total QR Frames:</span>
              <span className="text-slate-200 font-mono font-semibold text-right">
                {chunks.length} Chunks
              </span>

              <span className="text-slate-500">Modulation Space:</span>
              <span className="text-right font-bold text-xs uppercase">
                {colorMode === 'chromatic' ? (
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-pink-500 to-emerald-400">
                    4-Lane Chromatic (CMYG)
                  </span>
                ) : (
                  <span className="text-slate-400">Monochrome</span>
                )}
              </span>

              <span className="text-slate-500">Sonic Sync link:</span>
              <span className="text-right font-bold text-xs uppercase">
                {acousticSync ? (
                  <span className="text-amber-400 animate-pulse flex items-center justify-end gap-1 font-mono text-[10px]">
                    <Volume2 className="w-3 h-3" />
                    Acoustic Active
                  </span>
                ) : (
                  <span className="text-slate-505 text-[10px] font-mono">Inactive</span>
                )}
              </span>

              <span className="text-slate-500">Adaptive Controller:</span>
              <span className="text-right font-bold text-xs font-mono">
                {adaptiveFps ? (
                  <span className={`text-[10px] tracking-wider uppercase ${receiverActive ? 'text-emerald-400' : 'text-indigo-400 animate-pulse'}`}>
                    {receiverActive ? 'Linked (Full-Duplex)' : 'Sensing Scanner'}
                  </span>
                ) : (
                  <span className="text-slate-505 text-[10px]">Bypassed</span>
                )}
              </span>

              {adaptiveFps && (
                <>
                  <span className="text-slate-500">Flow Action:</span>
                  <span className="text-right text-[10px] font-mono font-semibold text-slate-300 truncate max-w-[190px] block">
                    {adaptiveLog}
                  </span>
                </>
              )}

              <span className="text-slate-500">Speed (Estimated):</span>
              <span className="text-slate-300 text-right font-medium">
                {((chunks.length / fps).toFixed(1))} sec per full loop
              </span>

              <span className="text-slate-500">Entropy Filter:</span>
              <span className="text-right font-bold text-xs uppercase">
                {differentialMode ? (
                  <span className="text-emerald-400 font-mono text-[10px]">Delta XOR Active</span>
                ) : (
                  <span className="text-slate-500 font-mono text-[10px]">Unfiltered</span>
                )}
              </span>
            </div>
          </div>

          {/* QR Canvas stage */}
          <div className="flex flex-col items-center justify-center relative">
            <div className="bg-white p-5 rounded-3xl shadow-2xl relative border-4 border-indigo-400/20 shadow-indigo-950/20">
              <canvas ref={canvasRef} className="rounded-xl w-72 h-72 block shadow-sm" id="qr-transmitter-canvas"></canvas>

              {/* Left & Right active pulsing indices */}
              <div className="absolute top-1/2 -left-2 transform -translate-y-1/2 w-4 h-8 rounded-r-full bg-indigo-600 block shadow-md shadow-indigo-950 transition-all duration-75 animate-pulse"></div>
              <div className="absolute top-1/2 -right-2 transform -translate-y-1/2 w-4 h-8 rounded-l-full bg-indigo-600 block shadow-md shadow-indigo-950 transition-all duration-75 animate-pulse"></div>
            </div>

            {/* active frame banner */}
            <div className="mt-4 flex items-center gap-3">
              <span className="text-xs font-bold px-3 py-1 rounded-full bg-slate-800 text-slate-300 border border-slate-700/60 shadow flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${activeFrame === 0 ? 'bg-amber-400 shadow-md shadow-amber-400/50' : 'bg-green-500 shadow-md shadow-green-400/50'} animate-ping`}></span>
                {activeFrame === 0 ? 'Frame 0: Metadata Payload' : `Frame ${activeFrame} / ${chunks.length - 1}`}
              </span>
            </div>
          </div>

          {/* Playback Controls Panel */}
          <div className="bg-slate-950 border border-slate-850 rounded-2xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <button
                onClick={handlePrev}
                className="p-3 rounded-xl border border-slate-800 hover:border-slate-705 bg-slate-900/60 hover:bg-slate-805 text-slate-300 hover:text-white transition-all"
                id="btn-prev-frame"
                title="Previous Frame"
              >
                <SkipBack className="w-5 h-5" />
              </button>

              <button
                onClick={() => setIsPlaying(!isPlaying)}
                className={`flex-1 py-3 px-6 rounded-xl flex items-center justify-center gap-2 font-bold select-none transition-all duration-150 ${
                  isPlaying
                    ? 'bg-amber-500 text-slate-950 hover:bg-amber-450 shadow-md shadow-amber-950/20'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-md shadow-emerald-950/20'
                }`}
                id="btn-play-pause"
              >
                {isPlaying ? (
                  <>
                    <Pause className="w-5 h-5 fill-current" />
                    Pause Sequence
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5 fill-current" />
                    Resume sequence ({fps} FPS)
                  </>
                )}
              </button>

              <button
                onClick={handleNext}
                className="p-3 rounded-xl border border-slate-800 hover:border-slate-75o bg-slate-900/60 hover:bg-slate-800 text-slate-300 hover:text-white transition-all"
                id="btn-next-frame"
                title="Next Frame"
              >
                <SkipForward className="w-5 h-5" />
              </button>
            </div>

            {/* Slider frame selection */}
            <div className="space-y-1.5 mt-1 text-left">
              <div className="flex justify-between text-[11px] font-mono text-slate-400">
                <span>Chunk Sequence Index</span>
                <span className="text-indigo-400 font-bold">{activeFrame} / {chunks.length - 1}</span>
              </div>
              <input
                type="range"
                min="0"
                max={chunks.length - 1}
                step="1"
                value={activeFrame}
                onChange={(e) => {
                  setIsPlaying(false);
                  setActiveFrame(parseInt(e.target.value));
                }}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                id="scrub-timeline"
              />
            </div>
          </div>

          {/* Grid of Dots Visualization! Every dot is a chunk. Green is completed payload, active is pulsing Indigo */}
          <div className="space-y-1 text-left">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest pl-1">
              Active Packets Map ({chunks.length})
            </span>
            <div className="bg-slate-950 rounded-xl p-3 border border-slate-900 flex flex-wrap gap-1.5 justify-start max-h-24 overflow-y-auto custom-scroll">
              {chunks.map((_, i) => {
                const isActive = i === activeFrame;
                const isMeta = i === 0;

                return (
                  <div
                    key={i}
                    onClick={() => {
                      setIsPlaying(false);
                      setActiveFrame(i);
                    }}
                    className={`w-4 h-4 rounded-md cursor-pointer transition-all flex items-center justify-center text-[8px] font-mono font-bold select-none ${
                      isActive
                        ? 'bg-indigo-500 text-white ring-2 ring-indigo-400 scale-110 shadow-lg shadow-indigo-600/30'
                        : isMeta
                        ? 'bg-amber-950/40 border border-amber-600/30 text-amber-500/80'
                        : 'bg-slate-900 border border-slate-800 text-slate-600 hover:border-slate-700'
                    }`}
                    title={isMeta ? 'Metadata frame [0]' : `Payload frame [${i}]`}
                  >
                    {i}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Reset button */}
          <button
            onClick={handleReset}
            className="w-full py-3 border border-slate-800 hover:border-slate-700 hover:bg-slate-950/40 rounded-xl text-slate-400 hover:text-white text-xs font-semibold flex items-center justify-center gap-2 transition-all mt-4"
            id="reset-tx"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Share Another File / Text
          </button>
        </div>
      )}
    </div>
  );
}
