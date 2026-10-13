import type { FC } from 'react'

type BrandMarkProps = {
  alt: string
  className?: string
  imageClassName?: string
}

/*
  The AIFit mark: an ink tile, a paper "A" and a volt pulse across the crossbar.
  Drawn inline so it is crisp at any size, themes with the page and costs no request.
  Brand colours are fixed on purpose: the logo does not invert in dark mode.
*/
const BrandMark: FC<BrandMarkProps> = ({ alt, className = '', imageClassName = '' }) => (
  <div className={`brand-mark ${className}`.trim()}>
    <svg
      className={`brand-mark-img ${imageClassName}`.trim()}
      viewBox="130 120 764 764"
      role="img"
      aria-label={alt}
      focusable="false"
    >
      <rect width="1024" height="1024" fill="#0c1020" />
      <path
        d="M258 734C330 544 408 366 512 238C616 366 694 544 766 734"
        fill="none"
        stroke="#f6f4ee"
        strokeWidth="92"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M372 574C418 526 468 502 524 502C582 502 622 526 652 574"
        fill="none"
        stroke="#d5f24b"
        strokeWidth="70"
        strokeLinecap="round"
      />
      <circle cx="512" cy="502" r="34" fill="#0c1020" />
      <circle cx="512" cy="502" r="18" fill="#d5f24b" />
    </svg>
  </div>
)

export default BrandMark
