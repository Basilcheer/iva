---------------------------- MODULE NightSession ----------------------------
(***************************************************************************)
(* Сессия ночного хода scripts/memory/rollup.ts одного периода: снятие      *)
(* сохранённой сессии при старте, create, файл сессии, чтение хода, уборка *)
(* reset + unlink. Запуски идут друг за другом (замок .memory.lock); каждый *)
(* может упасть на любом шаге (Crash) и получить сигнал в любой момент     *)
(* (Signal: только флаг stopping, обработчик постоянный).                  *)
(*                                                                         *)
(* Сервер: множество живых сессий live. reset может потеряться в любую     *)
(* сторону: применён без ответа, не применён; подтверждение бывает только, *)
(* когда цели на сервере нет (reset или no_active_session). create — POST: *)
(* сервер может создать сессию до ответа, после abort или падения клиента; *)
(* такая сессия без id в файле — окно create, множество lost (остаток).    *)
(* cancel в модели нет: безопасность держится на подтверждённом reset,     *)
(* отмена только экономит работу сервера.                                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  MaxRuns,     \* запусков ночи подряд
  Days,        \* дней (ходов) в одном запуске
  MaxSessions  \* граница счётчика id сессий

NONE == 0

VARIABLES
  file,      \* id в файле сессии, NONE — файла нет
  fileOk,    \* файл читается и валиден (FALSE — ручная порча)
  live,      \* живые сессии сервера
  lost,      \* созданные сервером сессии, чей id процесс не записал (окно create)
  nextId,
  run, pc, day,
  cur,       \* сессия текущего хода в памяти
  pending,   \* сессия, созданная сервером по идущему POST (NONE — ещё нет)
  stopping,
  afterStop  \* призрак: create или чтение начались при stopping (инвариант 2)

vars == <<file, fileOk, live, lost, nextId, run, pc, day, cur, pending, stopping,
          afterStop>>

States == {"start", "resetStart", "unlinkStart", "init", "ready", "posted",
           "reading", "cleanup", "unlink", "exited", "dead"}
Done == {"exited", "dead"}

Init ==
  /\ file = NONE /\ fileOk = TRUE /\ live = {} /\ lost = {} /\ nextId = 1
  /\ run = 1 /\ pc = "start" /\ day = 0 /\ cur = NONE /\ pending = NONE
  /\ stopping = FALSE /\ afterStop = FALSE

Go(l) == pc' = l

\* Новый id сессии на сервере.
NewSession == nextId < MaxSessions

(* ---------------------------- старт ------------------------------------ *)
\* Первым делом после аргументов и клиента: файл сессии.
Start ==
  /\ pc = "start"
  /\ IF file = NONE THEN Go("init")
     ELSE IF ~fileOk THEN Go("exited")          \* нечитаем: exit 1, create нет
     ELSE Go("resetStart")
  /\ UNCHANGED <<file, fileOk, live, lost, nextId, run, day, cur, pending,
                 stopping, afterStop>>

\* reset сохранённой сессии: применён или нет; подтверждён — только если цели нет.
ResetStart ==
  /\ pc = "resetStart"
  /\ \E applied, confirmed \in BOOLEAN :
       /\ live' = IF applied THEN live \ {file} ELSE live
       /\ IF confirmed /\ file \notin live' THEN Go("unlinkStart")
          ELSE Go("exited")                     \* файл цел, exit 1, create нет
  /\ UNCHANGED <<file, fileOk, lost, nextId, run, day, cur, pending, stopping,
                 afterStop>>

UnlinkStart ==
  /\ pc = "unlinkStart"
  /\ \/ file' = NONE /\ Go("init")
     \/ UNCHANGED file /\ Go("exited")           \* unlink не удался: exit 1
  /\ UNCHANGED <<fileOk, live, lost, nextId, run, day, cur, pending, stopping,
                 afterStop>>

\* Инструкции, vault, RAN_BEFORE, timezone, CORE, дни — только после уборки.
InitStep ==
  /\ pc = "init"
  /\ \/ Go("ready")
     \/ Go("exited")                             \* отказ инициализации: exit 1
  /\ UNCHANGED <<file, fileOk, live, lost, nextId, run, day, cur, pending,
                 stopping, afterStop>>

(* ---------------------------- ход дня ---------------------------------- *)
Post ==
  /\ pc = "ready"
  /\ IF stopping \/ day = Days \/ ~NewSession THEN Go("exited") /\ UNCHANGED afterStop
     ELSE Go("posted") /\ afterStop' = (afterStop \/ stopping)
  /\ UNCHANGED <<file, fileOk, live, lost, nextId, run, day, cur, pending,
                 stopping>>

\* Сервер принял POST и создал сессию; ответ ещё в пути.
ServerCreate ==
  /\ pc = "posted" /\ pending = NONE /\ NewSession
  /\ pending' = nextId /\ nextId' = nextId + 1 /\ live' = live \cup {nextId}
  /\ UNCHANGED <<file, fileOk, lost, run, pc, day, cur, stopping, afterStop>>

\* Ответ create дошёл. stopping — только reset; иначе saveSession (синхронно в том
\* же тике) и чтение; ошибка saveSession — уборка.
Response ==
  /\ pc = "posted" /\ pending # NONE
  /\ cur' = pending /\ pending' = NONE
  /\ IF stopping THEN /\ Go("cleanup") /\ UNCHANGED <<file, afterStop>>
     ELSE \/ /\ file' = pending /\ Go("reading")
             /\ afterStop' = (afterStop \/ stopping)
          \/ /\ Go("cleanup") /\ UNCHANGED <<file, afterStop>>
  /\ UNCHANGED <<fileOk, live, lost, nextId, run, day, stopping>>

\* abort до ответа POST: id неизвестен, сервер мог создать сессию или создаст её позже.
AbortPost ==
  /\ pc = "posted" /\ stopping
  /\ \/ /\ pending # NONE /\ lost' = lost \cup {pending}
        /\ UNCHANGED <<live, nextId>>
     \/ /\ pending = NONE /\ NewSession
        /\ live' = live \cup {nextId} /\ lost' = lost \cup {nextId}
        /\ nextId' = nextId + 1
     \/ /\ pending = NONE /\ UNCHANGED <<live, lost, nextId>>
  /\ pending' = NONE /\ Go("exited")
  /\ UNCHANGED <<file, fileOk, run, day, cur, stopping, afterStop>>

\* Ход кончился: граница, обрез, обрыв, abort по сроку или сигналу — дальше уборка.
TurnEnds ==
  /\ pc = "reading"
  /\ Go("cleanup")
  /\ UNCHANGED <<file, fileOk, live, lost, nextId, run, day, cur, pending,
                 stopping, afterStop>>

\* Сессия уборки, чей id не лёг в файл.
Unsaved == IF pc = "cleanup" /\ cur # file THEN {cur} ELSE {}

\* Уборка: ограниченный reset своей сессии.
Cleanup ==
  /\ pc = "cleanup"
  /\ \E applied, confirmed \in BOOLEAN :
       /\ live' = IF applied THEN live \ {cur} ELSE live
       /\ IF confirmed /\ cur \notin live'
          THEN Go("unlink") /\ UNCHANGED lost
          \* не подтверждён: файл цел, exit 1, create больше нет; сессия без файла
          \* (saveSession не удался, ответ create при stopping) — id только в stderr
          ELSE Go("exited") /\ lost' = lost \cup Unsaved
  /\ UNCHANGED <<file, fileOk, nextId, run, day, cur, pending, stopping,
                 afterStop>>

\* unlink после подтверждённого reset; следующий день — новый create.
Unlink ==
  /\ pc = "unlink"
  /\ \/ /\ file' = NONE /\ day' = day + 1 /\ cur' = NONE
        \* обрез дня — догон идёт дальше; прочие отказы — exit 1
        /\ \/ Go("ready")
           \/ Go("exited")
     \/ /\ UNCHANGED <<file, day, cur>> /\ Go("exited")
  /\ UNCHANGED <<fileOk, live, lost, nextId, run, pending, stopping,
                 afterStop>>

(* ---------------------------- среда ------------------------------------ *)
\* Сигнал или срок: только флаг. Повторный ничего не меняет.
Signal ==
  /\ pc \notin Done /\ ~stopping
  /\ stopping' = TRUE
  /\ UNCHANGED <<file, fileOk, live, lost, nextId, run, pc, day, cur, pending,
                 afterStop>>

\* Hard kill на любом шаге. Идущий POST мог создать сессию и после смерти клиента.
Crash ==
  /\ pc \notin Done
  /\ \/ /\ pc = "posted" /\ pending # NONE /\ lost' = lost \cup {pending}
        /\ UNCHANGED <<live, nextId>>
     \/ /\ pc = "posted" /\ pending = NONE /\ NewSession
        /\ live' = live \cup {nextId} /\ lost' = lost \cup {nextId}
        /\ nextId' = nextId + 1
     \/ /\ ~(pc = "posted" /\ pending # NONE)
        /\ lost' = lost \cup Unsaved /\ UNCHANGED <<live, nextId>>
  /\ pending' = NONE /\ Go("dead")
  /\ UNCHANGED <<file, fileOk, run, day, cur, stopping, afterStop>>

\* Ручная порча файла между запусками.
Corrupt ==
  /\ pc \in Done /\ file # NONE /\ fileOk
  /\ fileOk' = FALSE
  /\ UNCHANGED <<file, live, lost, nextId, run, pc, day, cur, pending, stopping,
                 afterStop>>

\* Следующая ночь: новый процесс, память пуста, файл и сервер — как оставили.
NextRun ==
  /\ pc \in Done /\ run < MaxRuns
  /\ run' = run + 1 /\ Go("start") /\ day' = 0 /\ cur' = NONE /\ pending' = NONE
  /\ stopping' = FALSE
  /\ UNCHANGED <<file, fileOk, live, lost, nextId, afterStop>>

Next ==
  \/ Start \/ ResetStart \/ UnlinkStart \/ InitStep
  \/ Post \/ ServerCreate \/ Response \/ AbortPost \/ TurnEnds
  \/ Cleanup \/ Unlink
  \/ Signal \/ Crash \/ Corrupt \/ NextRun

Spec == Init /\ [][Next]_vars

(* ---------------------------- инварианты ------------------------------- *)
TypeOK ==
  /\ pc \in States
  /\ file \in 0..MaxSessions /\ cur \in 0..MaxSessions /\ pending \in 0..MaxSessions
  /\ live \subseteq 1..MaxSessions /\ lost \subseteq 1..MaxSessions
  /\ stopping \in BOOLEAN /\ fileOk \in BOOLEAN

\* (1) create не уходит, пока сохранённая сессия не подтверждена снятой и файл не снят;
\*     инициализация, способная завершить запуск, тоже идёт только после этого.
NoCreateOverSaved == pc \in {"init", "ready", "posted"} => file = NONE

\* (2) после остановки ни одна сессия не сохраняется и не читается — только снимается.
NothingAfterStop == ~afterStop

\* (3) каждая известная процессу живая сессия сервера имеет id в файле либо стоит в окне
\*     create. Окно create: POST в пути; ответ пришёл, а id в файл не лёг (saveSession не
\*     удался или stopping) и уборка ещё идёт. Всё, что вышло из окна без reset, — lost:
\*     процесс его id не знает, файл о нём не говорит, модель его не считает — это
\*     названный остаток (specs/README.md), а не доказанное свойство.
InWindow(s) == (pc = "posted" /\ s = pending) \/ s \in Unsaved
KnownLiveHasFile == \A s \in live : s = file \/ s \in lost \/ InWindow(s)

\* Следствие (1)+(3): вне окна create среди известных процессу сессий не больше одного
\* писателя периода. Потерянные в окне (lost) сюда не входят.
OneKnownWriter == Cardinality(live \ lost) <= 1

\* Живость: без падений каждый запуск доходит до выхода. Проверяется с
\* WF на всех шагах процесса; среда (Signal, Crash, Corrupt) не обязана случаться.
ProcessSteps ==
  Start \/ ResetStart \/ UnlinkStart \/ InitStep \/ Post \/ ServerCreate \/ Response
  \/ AbortPost \/ TurnEnds \/ Cleanup \/ Unlink \/ NextRun
FairSpec == Spec /\ WF_vars(ProcessSteps)
RunsEnd == <>[](pc \in Done /\ run = MaxRuns)
=============================================================================
