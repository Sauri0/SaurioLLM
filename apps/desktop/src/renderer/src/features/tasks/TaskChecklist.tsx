// Checklist de tasks del plan (doc 04 §4.13 TaskManager, doc 01 §4.1 "feature tasks: checklist")
// — apps/desktop/src/renderer/src/features/tasks/TaskChecklist.tsx.
import type { Task } from '@saurio/shared';
import { CheckIcon } from '../../ui/icons.js';
import './tasks.css';

const STATUS_LABEL: Record<Task['status'], string> = {
  pending: 'Pendiente', in_progress: 'En curso', done: 'Hecho', skipped: 'Omitido',
};

export interface TaskChecklistProps {
  tasks: Task[];
}

/** Solo lectura en el MVP: el plan editable por el usuario es v0.2 (doc 06 "Previsto para más
 *  adelante" / doc 01 §9 tabla de alcance no lo lista para el MVP), acá se renderiza lo que
 *  `task_update` fue dejando en `tasks.updated` (RunEvent) sin controles de edición. */
export function TaskChecklist({ tasks }: TaskChecklistProps): React.JSX.Element {
  const sorted = [...tasks].sort((a, b) => a.ord - b.ord);
  if (sorted.length === 0) {
    return <p className="task-checklist__empty">Sin tareas todavía.</p>;
  }
  const done = sorted.filter((t) => t.status === 'done').length;
  return (
    <div>
      <div className="task-checklist__progress" aria-hidden="true">
        <div className="task-checklist__progress-fill" style={{ width: `${sorted.length ? (done / sorted.length) * 100 : 0}%` }} />
      </div>
      <ul className="task-checklist" aria-label={`Tareas: ${done} de ${sorted.length} hechas`}>
        {sorted.map((task) => (
          <li key={task.id} className={`task-checklist__item status-${task.status}`}>
            <span className="task-checklist__marker" aria-hidden="true">
              {task.status === 'done' && <CheckIcon width={9} height={9} stroke="var(--text-on-accent)" />}
            </span>
            <span className="task-checklist__title">{task.title}</span>
            <span className="task-checklist__status">{STATUS_LABEL[task.status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
