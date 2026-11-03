import React, { forwardRef } from "react";

/** Shared input surface. Native field sizing grows with text in both modes. */
export const PromptTextarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function PromptTextarea({ className = "", ...props }, ref) {
  return <textarea {...props} ref={ref} className={`promptTextarea ${className}`} rows={1}/>;
});
