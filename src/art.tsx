import { useId } from "react";
import type { StoryStyle } from "../shared/story";

// Small drawn samples of the same little scene (sun, hill, a character) in each picture style. They are drawings in
// the page, not AI pictures: they show the look, not a result. Light on purpose (the public pages use them too).

const ink = { stroke: "#15171d", strokeWidth: 2.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** The sample scene of one style (viewBox 100 × 120; a taller or wider frame crops it, centred). */
export function StyleArt({ style }: { style: StoryStyle }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ref = (name: string) => `url(#${id}${name})`;
  switch (style) {
    case "doodle":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <rect width="100" height="120" fill="#fbf6ec" />
          <circle cx="76" cy="24" r="11" fill="#ffe28a" {...ink} />
          <path d="M70 9 l-2 -5 M86 12 l4 -4 M90 26 h5" {...ink} fill="none" />
          <path d="M-4 96 Q30 70 58 88 T104 82 V124 H-4Z" fill="#bfe8cf" {...ink} />
          <rect x="34" y="62" width="26" height="30" rx="10" fill="#cdb8f2" {...ink} />
          <circle cx="47" cy="50" r="13" fill="#ffd3b5" {...ink} />
          <circle cx="42.5" cy="48" r="1.7" fill="#15171d" /><circle cx="51.5" cy="48" r="1.7" fill="#15171d" />
          <path d="M42 55 q5 4 10 0" {...ink} fill="none" />
          <path d="M14 30 q6 -6 12 0 q6 -6 12 0" {...ink} fill="none" />
        </svg>
      );
    case "watercolor":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <filter id={`${id}w`} x="-20%" y="-20%" width="140%" height="140%">
              <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="3" seed="3" />
              <feDisplacementMap in="SourceGraphic" scale="7" />
              <feGaussianBlur stdDeviation="1.4" />
            </filter>
          </defs>
          <rect width="100" height="120" fill="#f8f2e7" />
          <g filter={ref("w")} opacity="0.85">
            <ellipse cx="45" cy="30" rx="58" ry="26" fill="#a9cbe8" />
            <circle cx="74" cy="28" r="12" fill="#f4b483" />
            <path d="M-6 92 Q28 66 60 84 T108 78 V126 H-6Z" fill="#9fc89b" />
            <ellipse cx="47" cy="74" rx="12" ry="16" fill="#e59aa4" />
            <circle cx="47" cy="52" r="10" fill="#f3cfb2" />
          </g>
          <path d="M37 56 q10 6 20 0 M30 95 q20 -8 40 0" stroke="#8a7f70" strokeWidth="0.6" fill="none" opacity="0.6" />
        </svg>
      );
    case "clay":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <radialGradient id={`${id}s`} cx="35%" cy="30%" r="75%"><stop offset="0" stopColor="#ffd9a0" /><stop offset="1" stopColor="#e8862f" /></radialGradient>
            <radialGradient id={`${id}h`} cx="40%" cy="20%" r="90%"><stop offset="0" stopColor="#b6e3a8" /><stop offset="1" stopColor="#4f9a4a" /></radialGradient>
            <radialGradient id={`${id}b`} cx="35%" cy="28%" r="80%"><stop offset="0" stopColor="#ffc2cf" /><stop offset="1" stopColor="#d9637d" /></radialGradient>
            <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f6e2d2" /><stop offset="1" stopColor="#e6bfa5" /></linearGradient>
            <filter id={`${id}d`}><feDropShadow dx="1.5" dy="3" stdDeviation="2" floodOpacity="0.35" /></filter>
          </defs>
          <rect width="100" height="120" fill={ref("g")} />
          <circle cx="75" cy="25" r="12" fill={ref("s")} filter={ref("d")} />
          <ellipse cx="50" cy="104" rx="66" ry="26" fill={ref("h")} filter={ref("d")} />
          <ellipse cx="48" cy="66" rx="17" ry="20" fill={ref("b")} filter={ref("d")} />
          <circle cx="42" cy="61" r="3.4" fill="#fff" /><circle cx="54" cy="61" r="3.4" fill="#fff" />
          <circle cx="42.8" cy="61.6" r="1.7" fill="#2a1f22" /><circle cx="54.8" cy="61.6" r="1.7" fill="#2a1f22" />
          <path d="M43 71 q5 4 10 0" stroke="#8c2f45" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      );
    case "comic":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <pattern id={`${id}p`} width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.3" fill="#e9a70f" /></pattern>
          </defs>
          <rect width="100" height="120" fill="#ffd23f" />
          <rect width="100" height="120" fill={ref("p")} />
          <path d="M50 8 L56 26 L74 18 L64 34 L84 40 L64 46 L72 62 L54 52 L50 70 L44 52 L26 62 L34 46 L14 40 L34 34 L24 18 L42 26Z" fill="#fff" stroke="#111" strokeWidth="2.4" strokeLinejoin="round" />
          <path d="M-4 100 L30 80 L60 94 L104 76 V124 H-4Z" fill="#1d4ed8" stroke="#111" strokeWidth="3" strokeLinejoin="round" />
          <circle cx="50" cy="40" r="12" fill="#e63946" stroke="#111" strokeWidth="3" />
          <path d="M44 38 h3 M53 38 h3 M45 45 q5 3 10 0" stroke="#111" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <path d="M8 70 l14 4 M6 80 l16 0 M92 66 l-14 6" stroke="#111" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "flat":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <rect width="100" height="120" fill="#cfeee9" />
          <circle cx="72" cy="30" r="12" fill="#ff8a65" />
          <path d="M-6 100 L28 56 L58 100Z" fill="#2f5d62" />
          <path d="M30 100 L66 48 L106 100Z" fill="#3e8e7e" />
          <rect x="0" y="96" width="100" height="24" fill="#f7c873" />
          <rect x="18" y="84" width="16" height="14" fill="#e85d75" />
          <path d="M16 85 L26 76 L36 85Z" fill="#7b2d40" />
          <circle cx="80" cy="88" r="7" fill="#2f5d62" /><rect x="78.5" y="92" width="3" height="8" fill="#7b2d40" />
        </svg>
      );
    case "cinematic":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}k`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0f1b33" /><stop offset="0.55" stopColor="#7c3d4d" /><stop offset="0.8" stopColor="#f2a35e" /></linearGradient>
            <radialGradient id={`${id}u`} cx="62%" cy="74%" r="45%"><stop offset="0" stopColor="#ffe3a3" stopOpacity="0.95" /><stop offset="1" stopColor="#ffe3a3" stopOpacity="0" /></radialGradient>
            <radialGradient id={`${id}v`} cx="50%" cy="50%" r="70%"><stop offset="0.55" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity="0.6" /></radialGradient>
          </defs>
          <rect width="100" height="120" fill={ref("k")} />
          <rect width="100" height="120" fill={ref("u")} />
          <path d="M-4 96 Q24 80 46 90 T104 84 V124 H-4Z" fill="#14100f" />
          <path d="M30 92 v-14 q4 -10 8 0 v14Z" fill="#14100f" />
          <circle cx="34" cy="74" r="4" fill="#14100f" />
          <rect width="100" height="120" fill={ref("v")} />
          <rect width="100" height="9" fill="#000" /><rect y="111" width="100" height="9" fill="#000" />
        </svg>
      );
    case "anime":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3b82f6" /><stop offset="1" stopColor="#bfdbfe" /></linearGradient>
          </defs>
          <rect width="100" height="120" fill={ref("a")} />
          <path d="M8 46 q2 -12 14 -8 q4 -12 18 -6 q10 -6 16 4 q12 0 10 10Z" fill="#fff" />
          <path d="M14 44 q20 4 52 2 q0 4 -2 4 h-48Z" fill="#c7d9f5" />
          <path d="M-4 96 Q34 70 104 86 V124 H-4Z" fill="#4ade80" />
          <path d="M-4 104 Q40 84 104 96 V124 H-4Z" fill="#16a34a" />
          <path d="M78 18 l2 6 l6 2 l-6 2 l-2 6 l-2 -6 l-6 -2 l6 -2Z" fill="#fff" />
          <path d="M40 112 l6 -22 l6 22Z" fill="#1e3a8a" />
          <circle cx="46" cy="84" r="6" fill="#fde2cf" stroke="#1e293b" strokeWidth="1" />
          <path d="M40 82 q6 -10 12 0 q-6 -3 -12 0Z" fill="#1e293b" />
        </svg>
      );
    case "storybook":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <rect width="100" height="120" fill="#fbefd9" />
          <circle cx="74" cy="26" r="11" fill="#f7c873" />
          <path d="M-4 92 Q24 70 52 86 T104 80 V124 H-4Z" fill="#a8cf8e" />
          <path d="M60 82 v-16 l10 -9 l10 9 v16Z" fill="#e8a87c" stroke="#7a4b3a" strokeWidth="1.5" />
          <path d="M58 66 l12 -11 l12 11" fill="none" stroke="#b35c44" strokeWidth="3" strokeLinecap="round" />
          <rect x="67" y="72" width="6" height="10" rx="2" fill="#7a4b3a" />
          <ellipse cx="34" cy="80" rx="9" ry="11" fill="#f2b5a0" />
          <circle cx="34" cy="64" r="8" fill="#f6d6b8" />
          <path d="M27 60 q7 -9 14 0" fill="#c76f4e" />
          <circle cx="31.5" cy="65" r="1.2" fill="#5b3a2e" /><circle cx="36.5" cy="65" r="1.2" fill="#5b3a2e" />
          <path d="M10 30 q4 -3 8 0 M16 40 q4 -3 8 0" stroke="#d9a35b" strokeWidth="1.5" fill="none" />
        </svg>
      );
    case "toy3d":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8fd3ff" /><stop offset="1" stopColor="#e3f4ff" /></linearGradient>
            <radialGradient id={`${id}b`} cx="35%" cy="30%" r="75%"><stop offset="0" stopColor="#ffd27a" /><stop offset="1" stopColor="#f08a24" /></radialGradient>
            <radialGradient id={`${id}g`} cx="40%" cy="20%" r="90%"><stop offset="0" stopColor="#9be27f" /><stop offset="1" stopColor="#3e9a3a" /></radialGradient>
            <filter id={`${id}s`}><feDropShadow dx="0" dy="3" stdDeviation="2.5" floodOpacity="0.3" /></filter>
          </defs>
          <rect width="100" height="120" fill={ref("t")} />
          <ellipse cx="50" cy="110" rx="70" ry="26" fill={ref("g")} />
          <ellipse cx="50" cy="78" rx="16" ry="17" fill={ref("b")} filter={ref("s")} />
          <circle cx="50" cy="52" r="15" fill={ref("b")} filter={ref("s")} />
          <ellipse cx="44" cy="50" rx="4.5" ry="5.5" fill="#fff" /><ellipse cx="56" cy="50" rx="4.5" ry="5.5" fill="#fff" />
          <circle cx="45" cy="51" r="2.4" fill="#1d2433" /><circle cx="57" cy="51" r="2.4" fill="#1d2433" />
          <circle cx="45.8" cy="50" r="0.8" fill="#fff" /><circle cx="57.8" cy="50" r="0.8" fill="#fff" />
          <path d="M45 59 q5 4 10 0" stroke="#8a3b12" strokeWidth="2" strokeLinecap="round" fill="none" />
          <ellipse cx="38" cy="38" rx="4" ry="7" fill="#f08a24" transform="rotate(-25 38 38)" />
          <ellipse cx="62" cy="38" rx="4" ry="7" fill="#f08a24" transform="rotate(25 62 38)" />
        </svg>
      );
    case "dark":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}d`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0b1424" /><stop offset="1" stopColor="#1d2b3a" /></linearGradient>
            <radialGradient id={`${id}m`} cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#ffe9c4" /><stop offset="0.6" stopColor="#f0b36b" stopOpacity="0.5" /><stop offset="1" stopColor="#f0b36b" stopOpacity="0" /></radialGradient>
          </defs>
          <rect width="100" height="120" fill={ref("d")} />
          <circle cx="66" cy="30" r="20" fill={ref("m")} />
          <circle cx="66" cy="30" r="8" fill="#f7e2bd" />
          <path d="M-4 120 V88 L14 70 L24 82 L36 58 L50 80 L60 66 L76 86 L90 74 L104 90 V120Z" fill="#05080e" />
          <path d="M30 120 V74 h4 v-8 h3 v8 h4 V120Z" fill="#05080e" />
          <rect x="34" y="80" width="3" height="5" fill="#f0a24b" />
          <path d="M0 98 Q30 92 60 100 T100 96 V120 H0Z" fill="rgba(160,180,210,0.12)" />
        </svg>
      );
    case "vintage":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <filter id={`${id}n`}><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="5" /><feColorMatrix type="saturate" values="0" /><feComponentTransfer><feFuncA type="linear" slope="0.18" /></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply" /></filter>
            <linearGradient id={`${id}v`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e7c99a" /><stop offset="1" stopColor="#b98a5a" /></linearGradient>
          </defs>
          <rect width="100" height="120" fill="#efe6d4" />
          <g filter={ref("n")}>
            <rect x="8" y="8" width="84" height="84" fill={ref("v")} />
            <circle cx="66" cy="30" r="9" fill="#f7e3b8" opacity="0.9" />
            <path d="M8 70 Q30 58 52 66 T92 62 V92 H8Z" fill="#8a6a45" />
            <path d="M40 66 v-14 q4 -8 8 0 v14Z" fill="#4a3826" /><circle cx="44" cy="48" r="4" fill="#4a3826" />
          </g>
          <rect x="8" y="8" width="84" height="84" fill="none" stroke="#fffaf0" strokeWidth="0.8" />
          <path d="M14 104 h40" stroke="#9b8a73" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "oil":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <filter id={`${id}o`} x="-10%" y="-10%" width="120%" height="120%">
              <feTurbulence type="turbulence" baseFrequency="0.05 0.12" numOctaves="2" seed="8" />
              <feDisplacementMap in="SourceGraphic" scale="5" />
            </filter>
          </defs>
          <rect width="100" height="120" fill="#2b2016" />
          <g filter={ref("o")}>
            <path d="M0 0 H100 V70 H0Z" fill="#5b7a99" />
            <path d="M0 40 Q30 20 60 34 T100 30 V70 H0Z" fill="#8fa9b8" />
            <circle cx="70" cy="28" r="10" fill="#f2c56b" />
            <path d="M0 70 Q40 56 100 72 V120 H0Z" fill="#4a5a2a" />
            <path d="M44 100 L50 62 L58 100Z" fill="#7a2f22" />
            <circle cx="51" cy="58" r="5" fill="#e0b58c" />
          </g>
          <rect x="2" y="2" width="96" height="116" fill="none" stroke="#c8a24a" strokeWidth="4" />
        </svg>
      );
    case "sketch":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <pattern id={`${id}h`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0 V4" stroke="#6b6b6b" strokeWidth="0.8" /></pattern>
          </defs>
          <rect width="100" height="120" fill="#f5f2ea" />
          <circle cx="72" cy="28" r="10" fill="none" stroke="#3c3c3c" strokeWidth="1.2" />
          <path d="M-4 92 Q28 72 56 86 T104 80" fill="none" stroke="#3c3c3c" strokeWidth="1.4" />
          <path d="M-4 96 Q28 76 56 90 T104 84 V124 H-4Z" fill={ref("h")} opacity="0.7" />
          <circle cx="44" cy="56" r="9" fill="none" stroke="#2a2a2a" strokeWidth="1.4" />
          <path d="M44 65 v18 M44 70 l-9 8 M44 70 l9 6 M44 83 l-7 10 M44 83 l7 10" stroke="#2a2a2a" strokeWidth="1.4" strokeLinecap="round" fill="none" />
          <path d="M37 51 q7 -6 14 0" fill="none" stroke="#2a2a2a" strokeWidth="1" />
          <path d="M14 26 l10 -2 M16 30 l12 -3" stroke="#8a8a8a" strokeWidth="0.8" />
        </svg>
      );
    case "pixel":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true" shapeRendering="crispEdges">
          <rect width="100" height="120" fill="#5fb7ff" />
          <rect x="70" y="16" width="16" height="16" fill="#ffe14d" />
          <rect x="10" y="24" width="20" height="6" fill="#fff" /><rect x="14" y="20" width="10" height="4" fill="#fff" />
          <rect x="0" y="88" width="100" height="32" fill="#8a5a2b" />
          <rect x="0" y="84" width="100" height="6" fill="#3fbf3f" />
          <rect x="60" y="64" width="20" height="20" fill="#3fbf3f" /><rect x="66" y="56" width="8" height="8" fill="#3fbf3f" />
          <rect x="34" y="60" width="12" height="12" fill="#f4c28c" />
          <rect x="34" y="56" width="12" height="6" fill="#6b3a1e" />
          <rect x="36" y="64" width="2" height="2" fill="#000" /><rect x="42" y="64" width="2" height="2" fill="#000" />
          <rect x="32" y="72" width="16" height="12" fill="#e64545" />
          <rect x="34" y="84" width="4" height="4" fill="#2a3a8a" /><rect x="42" y="84" width="4" height="4" fill="#2a3a8a" />
        </svg>
      );
    case "neon":
      return (
        <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0a0420" /><stop offset="1" stopColor="#2a0a3f" /></linearGradient>
            <linearGradient id={`${id}u`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd84d" /><stop offset="1" stopColor="#ff3fa4" /></linearGradient>
            <filter id={`${id}g`}><feGaussianBlur stdDeviation="1.6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          <rect width="100" height="120" fill={ref("s")} />
          <circle cx="50" cy="52" r="20" fill={ref("u")} />
          <path d="M30 50 h40 M31 56 h38 M33 62 h34" stroke="#2a0a3f" strokeWidth="2.4" />
          <path d="M0 72 H100" stroke="#ff3fa4" strokeWidth="1.5" filter={ref("g")} />
          <g stroke="#3ff0ff" strokeWidth="1" filter={ref("g")} opacity="0.85">
            <path d="M50 72 L0 120 M50 72 L25 120 M50 72 L50 120 M50 72 L75 120 M50 72 L100 120" />
            <path d="M0 82 H100 M0 94 H100 M0 108 H100" />
          </g>
        </svg>
      );
  }
}

