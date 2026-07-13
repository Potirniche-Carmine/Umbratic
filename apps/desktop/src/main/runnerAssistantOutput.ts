export type BufferedRunnerAssistantOutput = {
  kind: "assistant" | "reasoning";
  text: string;
  at?: string;
  endedAt?: string;
};

export class RunnerAssistantOutputBuffer {
  private text = "";
  private at?: string;
  private endedAt?: string;
  private answerStarted = false;

  append(text: string, at?: string, endedAt?: string): BufferedRunnerAssistantOutput | null {
    if (!text) return null;
    if (this.answerStarted) {
      return { kind: "assistant", text, at, endedAt: endedAt ?? at };
    }
    this.text = `${this.text}${text}`;
    this.at = this.at ?? at;
    this.endedAt = endedAt ?? at ?? this.endedAt;
    return null;
  }

  startAnswer(): BufferedRunnerAssistantOutput | null {
    const working = this.drain("reasoning");
    this.answerStarted = true;
    return working;
  }

  continueWorking(): BufferedRunnerAssistantOutput | null {
    this.answerStarted = false;
    return this.drain("reasoning");
  }

  complete(): BufferedRunnerAssistantOutput | null {
    this.answerStarted = false;
    return this.drain("assistant");
  }

  fail(): BufferedRunnerAssistantOutput | null {
    this.answerStarted = false;
    return this.drain("reasoning");
  }

  private drain(kind: BufferedRunnerAssistantOutput["kind"]): BufferedRunnerAssistantOutput | null {
    if (!this.text) return null;
    const output = { kind, text: this.text, at: this.at, endedAt: this.endedAt };
    this.text = "";
    this.at = undefined;
    this.endedAt = undefined;
    return output;
  }
}
