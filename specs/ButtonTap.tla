---- MODULE ButtonTap ----
\* Отклик кнопки модели в Bridge (spec-w2 §3.1.4, ADR-0015). Модель написана ДО кода: одна
\* кнопка одного сообщения, до MaxTaps тапов, до MaxRestarts рестартов моста.
\*
\* Тап приходит апдейтом с новым update_id. Мост решает по памяти «уже нажато» (ключ
\* chat:message:data -> update_id того апдейта, который стал сообщением):
\*   - ключ есть и update_id другой — дубликат: «Уже выбрано», апдейт снят (offset сдвинут);
\*   - иначе апдейт свежий: память, правка кнопки в полёт, затем admission. Исход owned —
\*     апдейт в очереди, offset сдвинут; исход write-failed — offset не сдвинут, Telegram
\*     выдаст ТОТ ЖЕ апдейт снова (scripts/poller/main.ts: write-failed -> ingressBlocked).
\* Повторная выдача того же update_id обязана пройти как свежая: иначе кнопка уже «✅», а
\* нажатие пропало (spec-w2, раздел 6: повторная выдача).
\*
\* Тап разрешён и по помеченной кнопке: что клиенты не дают нажать disabled-кнопку, не
\* доказано (шаг 0 проверял правку без disabled), поэтому от двойного тапа держит только
\* память. Это строже, чем «Tap только при ~marked».
\*
\* Действие модели -> код (scripts/poller/control.ts)
\*   Tap        владелец жмёт кнопку: Telegram копит апдейт с новым update_id
\*   Handle(u)  handleButtonTap: дубликат (isRepeatTap) — ack «Уже выбрано», return true;
\*              иначе applyTelegramButtonTap, rememberTap, scheduleImpl(tap:<key>) с правкой,
\*              return false — admission (inbox.ts) с исходом owned или write-failed
\*   EditLands  editTapImpl -> true: кнопка «✅» на экране
\*   EditFails  editTapImpl -> false: строка журнала, кнопка прежняя, ключ в памяти
\*   Restart    рестарт моста: память и фоновые задачи пусты, Telegram и inbox на месте
\*
\* Мутанты (свидетели): KeyOnly = TRUE — дубликат по одному ключу без сверки update_id;
\* Memory = FALSE — памяти нет, каждый тап становится сообщением.
EXTENDS Naturals, FiniteSets

CONSTANTS
  MaxTaps,      \* сколько тапов владельца
  MaxRestarts,  \* сколько рестартов моста
  Memory,       \* TRUE — память «уже нажато» есть
  KeyOnly       \* TRUE — дубликат по ключу без сверки update_id (мутант)

Updates == 1..MaxTaps
None == 0

VARIABLES
  taps,         \* сколько апдейтов уже создано (следующий update_id = taps + 1)
  pending,      \* апдейты в Telegram, ещё не подтверждённые offset
  memory,       \* update_id в памяти по ключу кнопки; None — пусто
  admitted,     \* апдейты, ставшие сообщением в очереди
  marked,       \* кнопка на экране помечена «✅»
  editInFlight, \* правка кнопки в полёте
  restarts      \* сколько рестартов было

vars == <<taps, pending, memory, admitted, marked, editInFlight, restarts>>

TypeOK ==
  /\ taps \in 0..MaxTaps
  /\ pending \subseteq Updates
  /\ memory \in {None} \cup Updates
  /\ admitted \subseteq Updates
  /\ marked \in BOOLEAN
  /\ editInFlight \in BOOLEAN
  /\ restarts \in 0..MaxRestarts

Init ==
  /\ taps = 0
  /\ pending = {}
  /\ memory = None
  /\ admitted = {}
  /\ marked = FALSE
  /\ editInFlight = FALSE
  /\ restarts = 0

Tap ==
  /\ taps < MaxTaps
  /\ taps' = taps + 1
  /\ pending' = pending \cup {taps + 1}
  /\ UNCHANGED <<memory, admitted, marked, editInFlight, restarts>>

\* Дубликат: в памяти уже есть нажатие этой кнопки другим апдейтом.
Repeat(u) ==
  /\ Memory
  /\ memory # None
  /\ (KeyOnly \/ memory # u)

HandleRepeat(u) ==
  /\ u \in pending
  /\ Repeat(u)
  /\ pending' = pending \ {u}
  /\ UNCHANGED <<taps, memory, admitted, marked, editInFlight, restarts>>

\* Свежий апдейт: память, правка в полёт, admission с одним из двух исходов.
HandleFresh(u) ==
  /\ u \in pending
  /\ ~Repeat(u)
  /\ memory' = IF Memory THEN u ELSE memory
  /\ editInFlight' = TRUE
  /\ \/ /\ pending' = pending \ {u}          \* owned
        /\ admitted' = admitted \cup {u}
     \/ /\ UNCHANGED <<pending, admitted>>   \* write-failed
  /\ UNCHANGED <<taps, marked, restarts>>

EditLands ==
  /\ editInFlight
  /\ marked' = TRUE
  /\ editInFlight' = FALSE
  /\ UNCHANGED <<taps, pending, memory, admitted, restarts>>

EditFails ==
  /\ editInFlight
  /\ editInFlight' = FALSE
  /\ UNCHANGED <<taps, pending, memory, admitted, marked, restarts>>

Restart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ memory' = None
  /\ editInFlight' = FALSE
  /\ UNCHANGED <<taps, pending, admitted, marked>>

Next ==
  \/ Tap
  \/ \E u \in Updates : HandleRepeat(u) \/ HandleFresh(u)
  \/ EditLands
  \/ EditFails
  \/ Restart

Spec == Init /\ [][Next]_vars

\* Кнопка не помечена (и правка не летит) без нажатия, которое уже в очереди или ещё будет
\* обработано: «✅» на экране без хода — потерянное нажатие.
NoSwallow ==
  (marked \/ editInFlight) => (admitted \cup pending) # {}

\* Пока мост жив, одна кнопка — не больше одного сообщения.
OnePerProcess ==
  restarts = 0 => Cardinality(admitted) <= 1
====
