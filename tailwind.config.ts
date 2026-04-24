import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
import typography from "@tailwindcss/typography";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        // A gentle, slow opacity breathing — used as the streaming
        // indicator halo on the send/stop morph button. Tailwind's
        // built-in `animate-ping` (175 % scale + fade) and `animate-pulse`
        // (1.0 → 0.5) both read as too attention-grabbing for a "we're
        // working in the background" cue, so we use a calmer envelope
        // with a longer period and a low ceiling.
        "pulse-soft": {
          "0%, 100%": { opacity: "0.45" },
          "50%": { opacity: "0.12" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        blink: "blink 1s step-start infinite",
        "pulse-soft": "pulse-soft 2.4s ease-in-out infinite",
      },
      // Typography overrides — the chat content sits on the translucent
      // glass / gradient backdrop, so the default prose theme (which assumes
      // an opaque white/black surface) reads as either washed-out or
      // overbearing. We:
      //   - relax line-height + tighten vertical rhythm so multi-line
      //     answers don't feel cramped or balloon-y;
      //   - swap the heavy default <hr> for a subtle one-pixel divider;
      //   - give tables visible cell borders, header tint, and zebra rows
      //     so they're actually scannable on the gradient;
      //   - soften inline code into a translucent chip rather than a
      //     hard slab against the glass;
      //   - turn blockquotes into a calm left-rule callout instead of an
      //     italicised wall.
      typography: ({ theme }: { theme: (path: string) => string }) => ({
        // The chat content uses `prose prose-sm`. Both modifiers ship a
        // default rule that zeroes out `padding-inline-start` on the
        // first cell of every row (and `-end` on the last), so a
        // borderless table aligns flush with the surrounding article
        // text. Our table HAS a visible border, which makes that
        // behaviour read as a missing padding bug. We override the four
        // edge-cell rules. Because `prose-sm` rules are emitted *after*
        // the `prose` (DEFAULT) rules in the generated stylesheet, the
        // override has to live in BOTH variants — otherwise the
        // plugin's `prose-sm` defaults win the cascade.
        sm: {
          css: {
            "thead th:first-child": { paddingInlineStart: "0.85em" },
            "thead th:last-child:not(:first-child)": {
              paddingInlineEnd: "0.85em",
            },
            "tbody td:first-child, tfoot td:first-child": {
              paddingInlineStart: "0.85em",
            },
            "tbody td:last-child:not(:first-child), tfoot td:last-child:not(:first-child)":
              {
                paddingInlineEnd: "0.85em",
              },
          },
        },
        DEFAULT: {
          css: {
            "--tw-prose-body": "hsl(var(--foreground) / 0.92)",
            "--tw-prose-headings": "hsl(var(--foreground))",
            "--tw-prose-lead": "hsl(var(--foreground) / 0.85)",
            "--tw-prose-links": "hsl(var(--primary))",
            "--tw-prose-bold": "hsl(var(--foreground))",
            "--tw-prose-counters": "hsl(var(--muted-foreground))",
            "--tw-prose-bullets": "hsl(var(--foreground) / 0.35)",
            "--tw-prose-hr": "hsl(var(--foreground) / 0.10)",
            "--tw-prose-quotes": "hsl(var(--foreground) / 0.85)",
            "--tw-prose-quote-borders": "hsl(var(--primary) / 0.55)",
            "--tw-prose-captions": "hsl(var(--muted-foreground))",
            "--tw-prose-code": "hsl(var(--foreground))",
            "--tw-prose-pre-code": "hsl(var(--foreground) / 0.95)",
            "--tw-prose-pre-bg": "transparent",
            "--tw-prose-th-borders": "hsl(var(--foreground) / 0.18)",
            "--tw-prose-td-borders": "hsl(var(--foreground) / 0.10)",
            // Invert variants pick up the same vars — we apply these to
            // both light and dark; the underlying CSS variables already
            // flip with the theme.
            "--tw-prose-invert-body": "hsl(var(--foreground) / 0.92)",
            "--tw-prose-invert-headings": "hsl(var(--foreground))",
            "--tw-prose-invert-lead": "hsl(var(--foreground) / 0.85)",
            "--tw-prose-invert-links": "hsl(var(--primary))",
            "--tw-prose-invert-bold": "hsl(var(--foreground))",
            "--tw-prose-invert-counters": "hsl(var(--muted-foreground))",
            "--tw-prose-invert-bullets": "hsl(var(--foreground) / 0.35)",
            "--tw-prose-invert-hr": "hsl(var(--foreground) / 0.10)",
            "--tw-prose-invert-quotes": "hsl(var(--foreground) / 0.85)",
            "--tw-prose-invert-quote-borders": "hsl(var(--primary) / 0.55)",
            "--tw-prose-invert-captions": "hsl(var(--muted-foreground))",
            "--tw-prose-invert-code": "hsl(var(--foreground))",
            "--tw-prose-invert-pre-code": "hsl(var(--foreground) / 0.95)",
            "--tw-prose-invert-pre-bg": "transparent",
            "--tw-prose-invert-th-borders": "hsl(var(--foreground) / 0.18)",
            "--tw-prose-invert-td-borders": "hsl(var(--foreground) / 0.10)",

            // Looser leading + a touch more breathing room than the
            // default `prose-sm`, but still well below the desktop
            // article default — chat is read in chunks, not paragraphs.
            lineHeight: "1.65",
            color: "var(--tw-prose-body)",

            p: { marginTop: "0.6em", marginBottom: "0.6em" },

            "h1, h2, h3, h4, h5, h6": {
              fontWeight: "600",
              letterSpacing: "-0.005em",
            },
            h1: { marginTop: "1.2em", marginBottom: "0.5em", fontSize: "1.6em" },
            h2: { marginTop: "1.1em", marginBottom: "0.45em", fontSize: "1.3em" },
            h3: { marginTop: "1em", marginBottom: "0.4em", fontSize: "1.1em" },
            h4: { marginTop: "0.9em", marginBottom: "0.35em", fontSize: "1em" },

            // Subtle horizontal rule — replaces the heavy default 2px line
            // that was reading as an unintended UI divider in the chat.
            hr: {
              marginTop: "1.4em",
              marginBottom: "1.4em",
              borderTopWidth: "1px",
              borderColor: "var(--tw-prose-hr)",
              opacity: 0.6,
            },

            "ul, ol": {
              marginTop: "0.5em",
              marginBottom: "0.5em",
              paddingLeft: "1.4em",
            },
            li: { marginTop: "0.2em", marginBottom: "0.2em" },
            "li > p": { marginTop: "0.2em", marginBottom: "0.2em" },

            // Inline code — translucent chip with a hairline border so it
            // sits *on* the glass instead of fighting it.
            code: {
              backgroundColor: "hsl(var(--foreground) / 0.08)",
              border: "1px solid hsl(var(--foreground) / 0.10)",
              padding: "0.12em 0.38em",
              borderRadius: "0.35rem",
              fontWeight: "500",
              fontSize: "0.875em",
              fontFamily: theme("fontFamily.mono").toString(),
            },
            "code::before": { content: "none" },
            "code::after": { content: "none" },

            // Block code — the actual highlighted block is rendered by
            // CodeBlock; we just clear out prose's wrapping so it doesn't
            // double-pad.
            pre: {
              margin: 0,
              padding: 0,
              backgroundColor: "transparent",
              color: "inherit",
            },

            // Blockquote — calm left-rule callout with no italic wall.
            blockquote: {
              fontStyle: "normal",
              fontWeight: "400",
              borderLeftWidth: "3px",
              borderLeftColor: "var(--tw-prose-quote-borders)",
              backgroundColor: "hsl(var(--foreground) / 0.04)",
              padding: "0.5em 0.9em",
              borderRadius: "0 0.5rem 0.5rem 0",
              color: "var(--tw-prose-quotes)",
              marginTop: "0.9em",
              marginBottom: "0.9em",
            },
            "blockquote p:first-of-type::before": { content: "none" },
            "blockquote p:last-of-type::after": { content: "none" },

            // Tables — visible borders + header tint + zebra rows so they
            // are actually scannable on the gradient.
            //
            // Sizing notes:
            //   - `tableLayout: auto` (the browser default, set explicitly
            //     for clarity) lets the first column size to its longest
            //     unbreakable word instead of the right-side columns
            //     dominating and squeezing it down to a few px.
            //   - `wordBreak: normal` + `overflowWrap: break-word` on
            //     cells keeps short words intact and only fractures one
            //     when it truly cannot fit. Without this, an over-eager
            //     `overflow-wrap: anywhere` rule elsewhere in the chat
            //     causes header words to wrap a single character at a
            //     time ("Featur / e").
            //   - `display: block` + `overflowX: auto` on the table itself
            //     would normally enable horizontal scroll for very wide
            //     tables, but it disables `width: 100%` and the rounded
            //     border. The chat bubble's max-width keeps tables
            //     reasonable in practice; if a model emits something
            //     genuinely huge, individual cells will wrap rather than
            //     overflow.
            table: {
              fontSize: "0.92em",
              lineHeight: "1.5",
              marginTop: "0.9em",
              marginBottom: "0.9em",
              borderCollapse: "collapse",
              tableLayout: "auto",
              width: "100%",
              border: "1px solid var(--tw-prose-th-borders)",
              borderRadius: "0.5rem",
              overflow: "hidden",
            },
            thead: {
              backgroundColor: "hsl(var(--foreground) / 0.06)",
              borderBottomWidth: "1px",
              borderBottomColor: "var(--tw-prose-th-borders)",
            },
            "thead th": {
              fontWeight: "600",
              padding: "0.6em 0.85em",
              textAlign: "left",
              verticalAlign: "bottom",
              borderRight: "1px solid var(--tw-prose-td-borders)",
              wordBreak: "normal",
              overflowWrap: "break-word",
              hyphens: "manual",
            },
            "thead th:last-child": { borderRight: "none" },
            // Restore inline padding on edge cells. The typography plugin's
            // default rules (in both `DEFAULT` and the `prose-sm` size
            // variant) explicitly zero out `padding-inline-start` on the
            // first cell and `padding-inline-end` on the last cell so a
            // borderless table aligns with the surrounding article text.
            // Our table has visible borders, so without these overrides
            // the first/last column text sits flush against the frame.
            "thead th:first-child": { paddingInlineStart: "0.85em" },
            "thead th:last-child:not(:first-child)": {
              paddingInlineEnd: "0.85em",
            },
            "tbody tr": {
              borderBottomWidth: "1px",
              borderBottomColor: "var(--tw-prose-td-borders)",
            },
            "tbody tr:last-child": { borderBottomWidth: 0 },
            "tbody tr:nth-child(even)": {
              backgroundColor: "hsl(var(--foreground) / 0.025)",
            },
            "tbody td": {
              padding: "0.55em 0.85em",
              borderRight: "1px solid var(--tw-prose-td-borders)",
              verticalAlign: "top",
              wordBreak: "normal",
              overflowWrap: "break-word",
              hyphens: "manual",
            },
            "tbody td:last-child": { borderRight: "none" },
            "tbody td:first-child, tfoot td:first-child": {
              paddingInlineStart: "0.85em",
            },
            "tbody td:last-child:not(:first-child), tfoot td:last-child:not(:first-child)":
              {
                paddingInlineEnd: "0.85em",
              },

            a: {
              fontWeight: "500",
              textDecoration: "none",
              borderBottom: "1px solid hsl(var(--primary) / 0.45)",
            },
            "a:hover": {
              borderBottomColor: "hsl(var(--primary))",
            },
          },
        },
      }),
    },
  },
  plugins: [animate, typography],
};

export default config;
