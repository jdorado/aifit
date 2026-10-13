import type { FC } from 'react'

type BrandMarkProps = {
  alt: string
  className?: string
  imageClassName?: string
}

const BrandMark: FC<BrandMarkProps> = ({ alt, className = '', imageClassName = '' }) => (
  <div className={`brand-mark ${className}`.trim()}>
    <img src="/aifit-blue-192.png" alt={alt} className={`brand-mark-img ${imageClassName}`.trim()} />
  </div>
)

export default BrandMark
