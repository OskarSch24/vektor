import artwork from '../../../brand/icon-source.png';

/** Shared approved artwork for the app title and welcome screen. */
export function BrandIcon({ className = '' }: { className?: string }) {
  return (
    <img
      src={artwork}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`block object-cover ${className}`}
    />
  );
}
