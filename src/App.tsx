import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Transmitter from './components/Transmitter';
import Receiver from './components/Receiver';
import { Zap, Camera, ShieldCheck, Cpu, Smartphone, ArrowRight, Layers, WifiOff } from 'lucide-react';

type AppMode = 'menu' | 'send' | 'receive';

export default function App() {
  const [mode, setMode] = useState<AppMode>('menu');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans transition-colors duration-300">
      {/* Dynamic Background Mesh Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b12_1px,transparent_1px),linear-gradient(to_bottom,#1e293b12_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none"></div>
      
      {/* Main Header Brand */}
      <header className="container mx-auto max-w-5xl px-6 py-6 flex items-center justify-between border-b border-slate-900 relative z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-tr from-indigo-500 to-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-950/40 border border-indigo-400/20">
            <Layers className="w-5.5 h-5.5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
              QR File Share
            </h1>
            <span className="text-[10px] text-slate-500 uppercase tracking-widest block font-mono font-bold">V2.4 Protocol</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-[10px] font-bold text-slate-400 flex items-center gap-1.5 select-none hover:text-slate-350 transition-colors">
            <WifiOff className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            100% Client-Side Offline Transfer
          </span>
        </div>
      </header>

      {/* Main Container Stage */}
      <main className="flex-grow container mx-auto max-w-4xl px-4 py-8 flex items-center justify-center relative z-10">
        <AnimatePresence mode="wait">
          {mode === 'menu' && (
            <motion.div
              key="menu"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.3 }}
              className="w-full max-w-2xl space-y-8"
              id="main-landing-menu"
            >
              {/* Introduction Title */}
              <div className="text-center space-y-3">
                <h2 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl bg-clip-text text-transparent bg-gradient-to-b from-white via-slate-100 to-slate-400">
                  Air-Gapped Cross Platform File Transfer
                </h2>
                <p className="text-slate-400 text-sm max-w-lg mx-auto leading-relaxed">
                  Fast, wireless file sharing between iPhone, Android, and laptops using high-speed animated QR code streams. Completely offline.
                </p>
              </div>

              {/* Selection cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                {/* Mode A: Sender */}
                <div
                  onClick={() => setMode('send')}
                  className="bg-slate-900/45 border border-slate-800 hover:border-indigo-500/40 rounded-3xl p-6 cursor-pointer group hover:bg-slate-900/80 hover:shadow-xl hover:shadow-indigo-950/25 transition-all duration-300 relative overflow-hidden"
                  id="card-select-send"
                >
                  <div className="absolute -top-10 -right-10 w-32 h-32 bg-indigo-505/10 rounded-full blur-3xl pointer-events-none group-hover:bg-indigo-500/10 transition-colors"></div>
                  
                  <div className="w-12 h-12 bg-indigo-500/10 rounded-2xl border border-indigo-500/20 flex items-center justify-center group-hover:scale-105 transition-transform">
                    <Zap className="w-6 h-6 text-indigo-405 group-hover:text-indigo-400 transition-colors" />
                  </div>

                  <h3 className="text-lg font-bold text-slate-100 mt-4 group-hover:text-white transition-colors">
                    I want to Send
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 lines-spaced">
                    Package and compress any file, document, or text memo into an interactive, high-speed QR slideshow video.
                  </p>
                  
                  <div className="mt-4 flex items-center gap-1.5 text-xs text-indigo-400 font-bold group-hover:translate-x-1 transition-transform">
                    Activate Transmitter
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </div>

                {/* Mode B: Receiver */}
                <div
                  onClick={() => setMode('receive')}
                  className="bg-slate-900/45 border border-slate-800 hover:border-emerald-500/40 rounded-3xl p-6 cursor-pointer group hover:bg-slate-900/80 hover:shadow-xl hover:shadow-emerald-950/25 transition-all duration-300 relative overflow-hidden"
                  id="card-select-receive"
                >
                  <div className="absolute -top-10 -right-10 w-32 h-32 bg-emerald-505/10 rounded-full blur-3xl pointer-events-none group-hover:bg-emerald-500/10 transition-colors"></div>

                  <div className="w-12 h-12 bg-emerald-500/10 rounded-2xl border border-emerald-500/20 flex items-center justify-center group-hover:scale-105 transition-transform">
                    <Camera className="w-6 h-6 text-emerald-405 group-hover:text-emerald-400 transition-colors" />
                  </div>

                  <h3 className="text-lg font-bold text-slate-100 mt-4 group-hover:text-white transition-colors">
                    I want to Receive
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 lines-spaced">
                    Open your device's camera to scan a QR code sequence, monitor blocks assembly on-screen, and autocombine upon completion.
                  </p>

                  <div className="mt-4 flex items-center gap-1.5 text-xs text-emerald-400 font-bold group-hover:translate-x-1 transition-transform">
                    Launch Scanner view
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </div>
              </div>

              {/* Info Guide Bento Block */}
              <div className="bg-slate-900/30 border border-slate-850 rounded-3xl p-6 space-y-4">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 select-none">
                  <Smartphone className="w-4 h-4 text-slate-500" />
                  How to Transfer in 3 Easy Steps
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <span className="text-xs font-bold font-mono text-indigo-400 bg-indigo-950/40 border border-indigo-900 px-1.5 py-0.5 rounded">01</span>
                    <p className="text-xs font-bold text-slate-200 mt-1">Open on Both Phones</p>
                    <p className="text-[11px] text-slate-450 leading-relaxed">Load this page URL on both the iPhone and Android phones.</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs font-bold font-mono text-indigo-400 bg-indigo-950/40 border border-indigo-900 px-1.5 py-0.5 rounded">02</span>
                    <p className="text-xs font-bold text-slate-200 mt-1">Select File & Point Camera</p>
                    <p className="text-[11px] text-slate-450 leading-relaxed">Select a file on Mode Send. Point Mode Scanner's camera on the other device at the display.</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs font-bold font-mono text-indigo-400 bg-indigo-950/40 border border-indigo-900 px-1.5 py-0.5 rounded">03</span>
                    <p className="text-xs font-bold text-slate-200 mt-1">Auto Reconstruct</p>
                    <p className="text-[11px] text-slate-450 leading-relaxed">Wait as the bento grid highlights scanned packets. The file unzips and downloads instantly!</p>
                  </div>
                </div>
              </div>

              {/* Core Features list */}
              <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 pt-2 text-[11px] font-medium text-slate-500">
                <span className="flex items-center gap-1.5 select-none">
                  <ShieldCheck className="w-3.5 h-3.5 text-slate-455" />
                  No Data Uploaded to Cloud
                </span>
                <span className="hidden sm:inline text-slate-805">•</span>
                <span className="flex items-center gap-1.5 select-none">
                  <Cpu className="w-3.5 h-3.5 text-slate-455" />
                  Hardware Gzip Decompress
                </span>
                <span className="hidden sm:inline text-slate-805">•</span>
                <span className="flex items-center gap-1.5 select-none">
                  <WifiOff className="w-3.5 h-3.5 text-slate-455" />
                  Perfect for Flight Mode
                </span>
              </div>
            </motion.div>
          )}

          {mode === 'send' && (
            <motion.div
              key="send"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.2 }}
              className="w-full"
            >
              <Transmitter onBackToMenu={() => setMode('menu')} />
            </motion.div>
          )}

          {mode === 'receive' && (
            <motion.div
              key="receive"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.2 }}
              className="w-full"
            >
              <Receiver onBackToMenu={() => setMode('menu')} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Unified Footer */}
      <footer className="py-4 text-center border-t border-slate-900/60 text-[11px] text-slate-600 relative z-10 select-none">
        <p>© 2026 QR File Share • Zero-Tracking Open Protocol • Made for iOS and Android web browsers</p>
      </footer>
    </div>
  );
}
