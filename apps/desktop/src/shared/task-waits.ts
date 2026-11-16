// A task whose employees are still on work handed off in the background (or whose report is next in line)
// is not stopped and asks nothing of the person: the thread shows no card and no attention mark for it.
export const EMPLOYEES_REPORT_LOG = 'Waiting for the employees\' report'

interface WaitingTask { state: string; question?: string | undefined; approvals: readonly { answer?: unknown }[]; log: readonly { line: string }[] }
export const awaitingEmployees = (task: WaitingTask): boolean =>
  task.state === 'waiting' && !task.question && !task.approvals.some(approval => !approval.answer) && task.log.at(-1)?.line === EMPLOYEES_REPORT_LOG
