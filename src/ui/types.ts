/** Everything the agent reports to the outside world goes through this interface. */
export interface AgentUI {
  /** Streamed assistant text delta. */
  assistantText(delta: string): void;
  /** Streamed (summarized) thinking delta. */
  thinking(delta: string): void;
  /** Called once a streamed turn is complete. */
  turnEnd(): void;
  toolCall(name: string, input: unknown): void;
  toolResult(name: string, result: string, isError: boolean): void;
  subagentAnswer(answer: string): void;
  info(message: string): void;
  warn(message: string): void;
  askUser(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}
