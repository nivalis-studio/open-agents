"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SignInButton } from "@/components/auth/sign-in-button";
import installerConfig from "../../../../installer.config.json";

const installUrl = `https://${installerConfig.installDomain}${installerConfig.installPath}`;
const installCommand = `curl -fsSL ${installUrl} | bash`;

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 1800);
    } catch (error) {
      console.error(
        "Failed to copy:",
        error instanceof Error ? error.message : error,
      );
    }
  }, [text]);

  return (
    <motion.button
      type="button"
      onClick={handleCopy}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/[0.05] hover:text-white/60"
      aria-label="Copy to clipboard"
      whileHover={shouldReduceMotion ? undefined : { scale: 1.04 }}
      whileTap={shouldReduceMotion ? undefined : { scale: 0.95 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {copied ? (
          <motion.span
            key="copied"
            initial={
              shouldReduceMotion ? undefined : { opacity: 0, scale: 0.7, y: 2 }
            }
            animate={
              shouldReduceMotion ? undefined : { opacity: 1, scale: 1, y: 0 }
            }
            exit={
              shouldReduceMotion ? undefined : { opacity: 0, scale: 0.7, y: -2 }
            }
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <Check className="h-4 w-4 text-emerald-400" />
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={
              shouldReduceMotion ? undefined : { opacity: 0, scale: 0.7, y: 2 }
            }
            animate={
              shouldReduceMotion ? undefined : { opacity: 1, scale: 1, y: 0 }
            }
            exit={
              shouldReduceMotion ? undefined : { opacity: 0, scale: 0.7, y: -2 }
            }
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <Copy className="h-4 w-4" />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

export function SignedOutHero() {
  const shouldReduceMotion = useReducedMotion();

  const reveal = (delay: number, y = 16) => {
    if (shouldReduceMotion) {
      return {};
    }

    return {
      initial: { opacity: 0, y },
      animate: { opacity: 1, y: 0 },
      transition: {
        duration: 0.55,
        delay,
        ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
      },
    };
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#0a0a0b]">
      {/* Ambient glow effects */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute left-1/2 top-0 h-[600px] w-[1000px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500/[0.07] blur-[150px]"
          animate={
            shouldReduceMotion
              ? undefined
              : {
                  x: [-20, 12, -20],
                  y: [-10, 16, -10],
                  scale: [1, 1.06, 1],
                  opacity: [0.05, 0.09, 0.05],
                }
          }
          transition={
            shouldReduceMotion
              ? undefined
              : {
                  duration: 20,
                  repeat: Number.POSITIVE_INFINITY,
                  ease: "easeInOut",
                }
          }
        />
        <motion.div
          className="absolute bottom-0 right-0 h-[400px] w-[600px] translate-x-1/4 translate-y-1/4 rounded-full bg-blue-500/[0.05] blur-[120px]"
          animate={
            shouldReduceMotion
              ? undefined
              : {
                  x: [16, -12, 16],
                  y: [6, -10, 6],
                  scale: [1, 1.08, 1],
                  opacity: [0.04, 0.08, 0.04],
                }
          }
          transition={
            shouldReduceMotion
              ? undefined
              : {
                  duration: 24,
                  repeat: Number.POSITIVE_INFINITY,
                  ease: "easeInOut",
                  delay: 2,
                }
          }
        />
        <motion.div
          className="absolute bottom-1/3 left-0 h-[300px] w-[400px] -translate-x-1/2 rounded-full bg-violet-500/[0.04] blur-[100px]"
          animate={
            shouldReduceMotion
              ? undefined
              : {
                  x: [-10, 14, -10],
                  y: [10, -14, 10],
                  scale: [1, 1.05, 1],
                  opacity: [0.03, 0.06, 0.03],
                }
          }
          transition={
            shouldReduceMotion
              ? undefined
              : {
                  duration: 22,
                  repeat: Number.POSITIVE_INFINITY,
                  ease: "easeInOut",
                  delay: 1,
                }
          }
        />
      </div>

      {/* Dot grid pattern */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.4]"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      {/* Scanline effect */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
        }}
      />

      {/* Header */}
      <motion.header
        className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-8"
        {...reveal(0.08, 12)}
      >
        <div className="flex items-center gap-3">
          <motion.div
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03]"
            whileHover={
              shouldReduceMotion ? undefined : { rotate: -4, scale: 1.04 }
            }
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4 text-white/70"
            >
              <polyline points="4,17 10,11 4,5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </motion.div>
          <span className="text-lg font-medium tracking-tight text-white">
            Open Harness
          </span>
        </div>
        <div className="flex items-center gap-3">
          <motion.a
            href="https://github.com/vercel-labs/open-harness"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-white/50 transition-colors hover:border-white/[0.12] hover:bg-white/[0.04] hover:text-white/70"
            whileHover={shouldReduceMotion ? undefined : { y: -1 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <GitHubIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Open Source</span>
          </motion.a>
          <motion.div
            whileHover={shouldReduceMotion ? undefined : { y: -1 }}
            whileTap={shouldReduceMotion ? undefined : { y: 0, scale: 0.98 }}
          >
            <SignInButton className="h-9 border-0 bg-white px-4 text-sm font-medium text-black transition-colors hover:bg-white/90" />
          </motion.div>
        </div>
      </motion.header>

      {/* Main content */}
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-16">
        {/* Hero section */}
        <motion.div className="mb-12 max-w-2xl text-center" {...reveal(0.18)}>
          {/* Tech badge */}
          <motion.div
            className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.02] px-4 py-2 backdrop-blur"
            animate={
              shouldReduceMotion
                ? undefined
                : {
                    y: [0, -3, 0],
                    boxShadow: [
                      "0 0 0 rgba(16,185,129,0)",
                      "0 0 24px rgba(16,185,129,0.12)",
                      "0 0 0 rgba(16,185,129,0)",
                    ],
                  }
            }
            transition={
              shouldReduceMotion
                ? undefined
                : {
                    duration: 4,
                    repeat: Number.POSITIVE_INFINITY,
                    ease: "easeInOut",
                  }
            }
          >
            <div className="flex items-center gap-1">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400/60 animate-pulse" />
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400/40" />
            </div>
            <span className="text-xs text-white/40">
              Powered by AI SDK, Vercel AI Gateway, and Next.js
            </span>
          </motion.div>

          <motion.h1
            className="text-4xl font-semibold tracking-tight text-white sm:text-5xl"
            {...reveal(0.24)}
          >
            Ship code faster with
            <br />
            <span className="bg-gradient-to-r from-white via-white/90 to-white/60 bg-clip-text text-transparent">
              AI that runs anywhere
            </span>
          </motion.h1>

          <motion.p
            className="mx-auto mt-6 max-w-lg text-base leading-relaxed text-white/50"
            {...reveal(0.32)}
          >
            A cloud platform and CLI that share the same AI workflows. Start in
            the browser, continue locally, or work entirely from your terminal.
          </motion.p>
        </motion.div>

        {/* Cards section */}
        <div className="w-full max-w-3xl">
          <motion.div
            className="grid gap-4 sm:grid-cols-2"
            initial={shouldReduceMotion ? undefined : "hidden"}
            animate={shouldReduceMotion ? undefined : "visible"}
            variants={
              shouldReduceMotion
                ? undefined
                : {
                    hidden: { opacity: 1 },
                    visible: {
                      opacity: 1,
                      transition: {
                        delayChildren: 0.38,
                        staggerChildren: 0.12,
                      },
                    },
                  }
            }
          >
            {/* Web card - Terminal style */}
            <motion.div
              className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#111113]/80 shadow-2xl shadow-black/20 backdrop-blur-xl"
              variants={
                shouldReduceMotion
                  ? undefined
                  : {
                      hidden: { opacity: 0, y: 20, scale: 0.98 },
                      visible: {
                        opacity: 1,
                        y: 0,
                        scale: 1,
                        transition: {
                          duration: 0.55,
                          ease: [0.16, 1, 0.3, 1],
                        },
                      },
                    }
              }
              whileHover={
                shouldReduceMotion
                  ? undefined
                  : {
                      y: -5,
                      scale: 1.01,
                    }
              }
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              {/* Window chrome */}
              <div className="flex items-center gap-2 border-b border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                  <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
                  <div className="h-3 w-3 rounded-full bg-[#28c840]" />
                </div>
                <div className="ml-3 flex-1">
                  <span className="font-mono text-xs text-white/30">
                    browser
                  </span>
                </div>
              </div>

              {/* Content */}
              <div className="p-5">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-5 w-5 text-white/60"
                  >
                    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                  </svg>
                </div>

                <h2 className="mb-2 text-lg font-medium tracking-tight text-white">
                  Start on the web
                </h2>
                <p className="mb-5 text-sm leading-relaxed text-white/40">
                  Run the coding agent from anywhere - no local setup required.
                  Just sign in and start shipping.
                </p>

                <SignInButton className="h-10 w-full border-0 bg-white text-sm font-medium text-black transition-all hover:bg-white/90" />
              </div>
            </motion.div>

            {/* CLI card - Terminal style */}
            <motion.div
              className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#111113]/80 shadow-2xl shadow-black/20 backdrop-blur-xl"
              variants={
                shouldReduceMotion
                  ? undefined
                  : {
                      hidden: { opacity: 0, y: 20, scale: 0.98 },
                      visible: {
                        opacity: 1,
                        y: 0,
                        scale: 1,
                        transition: {
                          duration: 0.55,
                          ease: [0.16, 1, 0.3, 1],
                        },
                      },
                    }
              }
              whileHover={
                shouldReduceMotion
                  ? undefined
                  : {
                      y: -5,
                      scale: 1.01,
                    }
              }
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              {/* Window chrome */}
              <div className="flex items-center gap-2 border-b border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                  <div className="h-3 w-3 rounded-full bg-[#febc2e]" />
                  <div className="h-3 w-3 rounded-full bg-[#28c840]" />
                </div>
                <div className="ml-3 flex-1">
                  <span className="font-mono text-xs text-white/30">
                    terminal
                  </span>
                </div>
              </div>

              {/* Content */}
              <div className="p-5">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-5 w-5 text-white/60"
                  >
                    <polyline points="4,17 10,11 4,5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                </div>

                <h2 className="mb-2 text-lg font-medium tracking-tight text-white">
                  Run it locally
                </h2>
                <p className="mb-5 text-sm leading-relaxed text-white/40">
                  Install the CLI to run the same AI workflows directly on your
                  machine.
                </p>

                {/* Install command */}
                <motion.div
                  className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] py-1 pl-4 pr-1 font-mono text-sm"
                  whileHover={
                    shouldReduceMotion
                      ? undefined
                      : {
                          borderColor: "rgba(255,255,255,0.18)",
                          backgroundColor: "rgba(255,255,255,0.045)",
                        }
                  }
                  transition={{ duration: 0.2, ease: "easeOut" }}
                >
                  <code className="flex-1 truncate text-white/60">
                    {installCommand}
                  </code>
                  <CopyButton text={installCommand} />
                </motion.div>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </main>
    </div>
  );
}
