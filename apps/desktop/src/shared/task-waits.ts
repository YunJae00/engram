export const EMPLOYEES_REPORT_LOG = 'Waiting for the employees\' report'

interface WaitingTask { state: string; question?: string | undefined; approvals: readonly { answer?: unknown }[]; awaitingEmployees?: boolean | undefined }
export const awaitingEmployees = (task: WaitingTask): boolean =>
  task.state === 'waiting' && !task.question && !task.approvals.some(approval => !approval.answer) && task.awaitingEmployees === true
