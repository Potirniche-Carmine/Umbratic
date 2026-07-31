export type ResponseRating = "good" | "bad";

export const responseFeedbackReasons = {
  good: [
    "Good answer",
    "Solved my issue",
    "Clear and concise",
    "Helpful details",
    "Followed instructions",
  ],
  bad: [
    "Incorrect answer",
    "Did not solve my issue",
    "Hard to understand",
    "Missing details",
    "Did not follow instructions",
  ],
} as const satisfies Record<ResponseRating, readonly string[]>;

export type ResponseFeedbackReason =
  (typeof responseFeedbackReasons)[ResponseRating][number];

export function isResponseFeedbackReason(
  rating: ResponseRating,
  value: unknown,
): value is ResponseFeedbackReason {
  return typeof value === "string"
    && (responseFeedbackReasons[rating] as readonly string[]).includes(value);
}
