import type { Components } from 'react-markdown';
import { QuestionImage } from '@/components/QuestionImage';

export const questionMarkdownComponents: Components = {
  p: ({ children, ...props }) => (
    <p className="whitespace-pre-wrap" {...props}>
      {children}
    </p>
  ),
  img: ({ src, alt }) => {
    if (!src || typeof src !== 'string') return null;
    return (
      <QuestionImage
        src={src}
        alt={typeof alt === 'string' && alt.trim() ? alt : 'Clinical Image'}
        className="my-3"
      />
    );
  },
};

export const questionMarkdownInlineComponents: Components = {
  p: ({ children, ...props }) => <span {...props}>{children}</span>,
  img: questionMarkdownComponents.img,
};

export const questionMarkdownExplanationComponents: Components = {
  p: ({ children, ...props }) => (
    <p className="whitespace-pre-wrap [&:not(:first-child)]:mt-2" {...props}>
      {children}
    </p>
  ),
  img: questionMarkdownComponents.img,
};
