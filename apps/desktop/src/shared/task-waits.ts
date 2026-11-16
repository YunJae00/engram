// A task whose employees are still on work handed off in the background (or whose report is next in line)
// is not stopped and asks nothing of the person: the thread shows no card and no attention mark for it.
export const EMPLOYEES_REPORT_LOG = 'Waiting for the employees\' report'

// The reason is the task's own stored fact (set when its turn ends), never its last log line: progress is logged onto a waiting task
// while the employees work ("김대리 handed over to 박사원"), and a card keyed on the log came back on every handoff (c1fix r1).
interface WaitingTask { state: string; question?: string | undefined; approvals: readonly { answer?: unknown }[]; awaitingEmployees?: boolean | undefined }
export const awaitingEmployees = (task: WaitingTask): boolean =>
  task.state === 'waiting' && !task.question && !task.approvals.some(approval => !approval.answer) && task.awaitingEmployees === true
