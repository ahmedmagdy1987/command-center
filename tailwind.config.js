/**
 * Tailwind is the delivery mechanism for the tokens in src/styles/tokens.css.
 * It defines NO colour values of its own — every entry below points at a
 * variable, so `bg-surface` renders correctly in dark, light, and inside an
 * inverted island with no per-theme class and no !important anywhere.
 *
 * TWO SHAPES, MATCHING THE TWO TOKEN FORMATS (see tokens.css header):
 *
 *   rgb(var(--x) / <alpha-value>)   for RGB-triple tokens.
 *                                   Supports opacity modifiers: `text-secondary/70`.
 *
 *   'var(--x)'                      for tokens that already carry their own alpha.
 *                                   Opacity modifiers do NOT apply — the alpha IS
 *                                   the semantic step (fill-subtle < fill < fill-strong).
 *
 * Using the wrong shape fails SILENTLY: a triple in the second position yields
 * `rgb(rgba(...) / 1)`, which is invalid and paints nothing. If a surface goes
 * transparent after adding a token, check this first.
 *
 * The default Tailwind palette is intentionally left intact. The migration is
 * incremental, so `violet-500` and friends must keep resolving until the last
 * call site moves over. Removing the palette is a Phase 2 decision, not this one.
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces — the elevation ladder.
        canvas: 'rgb(var(--color-canvas) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          raised: 'rgb(var(--color-surface-raised) / <alpha-value>)',
        },

        // Text. Used as `text-primary`, `text-secondary`, `text-muted`, `text-faint`.
        primary: 'rgb(var(--color-text-primary) / <alpha-value>)',
        secondary: 'rgb(var(--color-text-secondary) / <alpha-value>)',
        muted: 'rgb(var(--color-text-muted) / <alpha-value>)',
        faint: 'rgb(var(--color-text-faint) / <alpha-value>)',

        // Fills — translucent washes. Replaces the `bg-white/[0.0N]` idiom.
        fill: {
          DEFAULT: 'var(--color-fill)',
          subtle: 'var(--color-fill-subtle)',
          strong: 'var(--color-fill-strong)',
        },

        // Borders. Named `line` rather than `border`, because `border-border`
        // reads badly and bare `border` is already a width utility.
        line: {
          DEFAULT: 'var(--color-border)',
          subtle: 'var(--color-border-subtle)',
          strong: 'var(--color-border-strong)',
        },

        // Brand — identity only. Never the default colour of an arbitrary button.
        // Every accent colour carries the same three roles — see tokens.css:
        //   DEFAULT = fill · hover = emphasis/border · text = legible on dark
        brand: {
          DEFAULT: 'rgb(var(--color-brand) / <alpha-value>)',
          hover: 'rgb(var(--color-brand-hover) / <alpha-value>)',
          text: 'rgb(var(--color-brand-text) / <alpha-value>)',
          'text-hover': 'rgb(var(--color-brand-text-hover) / <alpha-value>)',
          alt: 'rgb(var(--color-brand-alt) / <alpha-value>)',
          'alt-hover': 'rgb(var(--color-brand-alt-hover) / <alpha-value>)',
          'alt-text': 'rgb(var(--color-brand-alt-text) / <alpha-value>)',
          fg: 'rgb(var(--color-brand-fg) / <alpha-value>)',
          surface: 'var(--color-brand-surface)',
        },
        accent: 'rgb(var(--color-accent) / <alpha-value>)',

        // Status — semantic. red=danger, green=success, amber=warning, blue=info.
        success: {
          DEFAULT: 'rgb(var(--color-success) / <alpha-value>)',
          hover: 'rgb(var(--color-success-hover) / <alpha-value>)',
          text: 'rgb(var(--color-success-text) / <alpha-value>)',
          surface: 'var(--color-success-surface)',
        },
        warning: {
          DEFAULT: 'rgb(var(--color-warning) / <alpha-value>)',
          hover: 'rgb(var(--color-warning-hover) / <alpha-value>)',
          text: 'rgb(var(--color-warning-text) / <alpha-value>)',
          surface: 'var(--color-warning-surface)',
        },
        danger: {
          DEFAULT: 'rgb(var(--color-danger) / <alpha-value>)',
          hover: 'rgb(var(--color-danger-hover) / <alpha-value>)',
          text: 'rgb(var(--color-danger-text) / <alpha-value>)',
          surface: 'var(--color-danger-surface)',
        },
        info: {
          DEFAULT: 'rgb(var(--color-info) / <alpha-value>)',
          hover: 'rgb(var(--color-info-hover) / <alpha-value>)',
          text: 'rgb(var(--color-info-text) / <alpha-value>)',
          surface: 'var(--color-info-surface)',
        },

        overlay: 'var(--color-overlay)',

        // Inverse — the deliberately theme-opposing CTA. See tokens.css.
        inverse: {
          DEFAULT: 'rgb(var(--color-inverse) / <alpha-value>)',
          fg: 'rgb(var(--color-inverse-fg) / <alpha-value>)',
        },
        tooltip: {
          DEFAULT: 'var(--color-tooltip)',
          fg: 'rgb(var(--color-tooltip-fg) / <alpha-value>)',
        },

        // Input wells are a recess, not an overlay. See tokens.css.
        input: {
          DEFAULT: 'var(--color-input)',
          focus: 'var(--color-input-focus)',
        },
      },

      // The identity gradient, as `bg-brand-gradient` / `bg-brand-gradient-cta`.
      // Phase 2 retargets both from two lines in tokens.css.
      backgroundImage: {
        'brand-gradient': 'var(--gradient-brand)',
        'brand-gradient-cta': 'var(--gradient-brand-cta)',
        'hero-private': 'var(--gradient-hero-private)',
        'hero-mine': 'var(--gradient-hero-mine)',
      },

      // Additive only — Tailwind's own xs/sm/base are untouched on purpose.
      fontSize: {
        micro: ['var(--text-micro)', { lineHeight: '1.4' }],
        meta: ['var(--text-meta)', { lineHeight: '1.45' }],
        note: ['var(--text-note)', { lineHeight: '1.5' }],
        compact: ['var(--text-compact)', { lineHeight: '1.5' }],
      },

      // NOTE: do NOT map shadow-sm/md/lg onto --shadow-*. Overriding those keys sets
      // both --tw-shadow and --tw-shadow-colored to the same OPAQUE value, which
      // silently disables Tailwind's coloured-shadow modifier — `shadow-brand/30`
      // and friends (24 call sites) become no-ops. It also made `shadow-lg` heavier
      // than `shadow-xl`. The --shadow-* tokens still exist in tokens.css for
      // deliberate use via arbitrary values; they must not hijack the size scale.

      fontFamily: {
        sans: 'var(--font-sans)',
        display: 'var(--font-display)',
        mono: 'var(--font-mono)',
      },
    },
  },
  plugins: [],
};
