import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { CodeBlock } from "./CodeBlock";
import { cn } from "@/lib/utils";

interface MarkdownProps {
  content: string;
  className?: string;
}

function extractRaw(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractRaw).join("");
  if (
    node &&
    typeof node === "object" &&
    "props" in (node as Record<string, unknown>)
  ) {
    const props = (node as { props?: { children?: React.ReactNode } }).props;
    return extractRaw(props?.children);
  }
  return "";
}

export function Markdown({ content, className }: MarkdownProps) {
  return (
    <div
      className={cn(
        "prose prose-invert max-w-none text-sm leading-relaxed",
        "prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2",
        "prose-pre:p-0 prose-pre:bg-transparent prose-pre:my-0",
        "prose-code:before:hidden prose-code:after:hidden",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre({ children }) {
            // Pull language from the inner <code class="language-xyz">
            const child = Array.isArray(children) ? children[0] : children;
            let language = "";
            if (
              child &&
              typeof child === "object" &&
              "props" in (child as Record<string, unknown>)
            ) {
              const cls =
                (child as { props?: { className?: string } }).props?.className ?? "";
              const m = /language-(\w+)/.exec(cls);
              if (m) language = m[1];
            }
            const raw = extractRaw(children);
            return (
              <CodeBlock raw={raw} language={language}>
                {children}
              </CodeBlock>
            );
          },
          code({ className: cls, children, ...props }) {
            // Inline code only — block code is wrapped by `pre` above.
            return (
              <code
                className={cn(
                  "rounded bg-muted px-1 py-0.5 font-mono text-[12.5px]",
                  cls,
                )}
                {...props}
              >
                {children}
              </code>
            );
          },
          a({ children, href, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary underline-offset-2 hover:underline"
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
