// Small decorative brand glyphs for the notebook language sections. lucide has no brand icons, so
// these are inline SVGs (recognizable, two-tone), sized to 1em to sit inline with a heading.

// Python's two-snake logo (blue upper, yellow lower).
export const PythonIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 256 255" className="size-full" role="img" aria-label="Python">
    <defs>
      <linearGradient id="py-blue" x1="12.96%" y1="12.04%" x2="79.64%" y2="78.2%">
        <stop offset="0%" stopColor="#387EB8" />
        <stop offset="100%" stopColor="#366994" />
      </linearGradient>
      <linearGradient id="py-yellow" x1="19.13%" y1="20.58%" x2="90.74%" y2="88.43%">
        <stop offset="0%" stopColor="#FFE052" />
        <stop offset="100%" stopColor="#FFC331" />
      </linearGradient>
    </defs>
    <path
      fill="url(#py-blue)"
      d="M126.916.072c-64.832 0-60.784 28.115-60.784 28.115l.072 29.128h61.868v8.745H41.631S.145 61.355.145 126.77c0 65.417 36.21 63.097 36.21 63.097h21.61v-30.356s-1.165-36.21 35.632-36.21h61.362s34.475.557 34.475-33.319V33.97S234.681.072 126.916.072zM92.802 19.66a11.12 11.12 0 0 1 11.13 11.13 11.12 11.12 0 0 1-11.13 11.13 11.12 11.12 0 0 1-11.13-11.13 11.12 11.12 0 0 1 11.13-11.13z"
    />
    <path
      fill="url(#py-yellow)"
      d="M128.757 254.126c64.832 0 60.784-28.115 60.784-28.115l-.072-29.127H127.6v-8.745h86.441s41.486 4.705 41.486-60.712c0-65.416-36.21-63.096-36.21-63.096h-21.61v30.355s1.165 36.21-35.632 36.21h-61.362s-34.475-.557-34.475 33.32v56.013s-5.235 33.897 102.53 33.897zm34.114-19.586a11.12 11.12 0 0 1-11.13-11.13 11.12 11.12 0 0 1 11.13-11.131 11.12 11.12 0 0 1 11.13 11.13 11.12 11.12 0 0 1-11.13 11.13z"
    />
  </svg>
)

// The R logo: a grey ellipse with a blue "R".
export const RIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 512 398" className="size-full" role="img" aria-label="R">
    <path
      fill="#CBCED0"
      d="M256 92c-114.9 0-208 51.4-208 114.8 0 63.5 93.1 114.9 208 114.9s208-51.4 208-114.9C464 143.4 370.9 92 256 92zm31.9 199.8c-84.6 0-153.2-38.3-153.2-85.5 0-47.3 68.6-85.6 153.2-85.6s148.6 24.2 148.6 85.6c0 61.3-64 85.5-148.6 85.5z"
    />
    <path
      fill="#2066B2"
      d="M320.5 260.6s10.7 3.2 17 6.7c2.1 1.2 5.6 3.7 8.1 6.6l40.7 68.8-65.3.1-30.8-57.8s-6.3-10.9-10.2-14c-3.3-2.6-4.7-3.5-8-3.5h-15.5l.1 75.2-57.9.1V151.9h116s52.8.9 52.8 51.2c0 50.2-47.9 57.5-47.9 57.5zm-25.2-67.4l-35.4-.1v32.4l35.4-.1s16.4-.1 16.4-16.4c0-16.6-16.4-15.8-16.4-15.8z"
    />
  </svg>
)
