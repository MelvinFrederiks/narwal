from typing import Generic, NotRequired, TypedDict, TypeVar


# Basic dicts shared by all runs
class AttackResult(TypedDict):
    label: str
    recovered: int
    coverage: float


A = TypeVar("A", bound=AttackResult)


class JobResultBase(TypedDict, Generic[A]):
    goal_size: int
    attacks: list[A]
    combined_recovered: int
    combined_coverage: float


# Mergeability
# Statistics on overlap between two attacks
class PairStats(TypedDict):
    a: str
    b: str
    recovered_a: int
    recovered_b: int
    shared: int
    only_a: int
    only_b: int
    union: int
    jaccard: float
    mergeability: float
    union_coverage: float


# Result of a mergability run
class MergeabilityResult(JobResultBase[AttackResult]):
    pairs: list[PairStats]


# Ordering
class OrderingAttackResult(AttackResult):
    guesses: int | None
    rate_per_guess: float | None
    duration_s: float | None
    rate_per_s: float | None
    exclusive: int


# Histogram of all single ordering runs
class OrderingDistribution(TypedDict):
    min: float
    max: float
    mean: float
    bin_min: float
    bin_width: float
    bins: list[int]


# Of a single ordering run, the info on the status when the milestones (25%, 50%, etc) are crossed
# `cost` is on the ranking's axis (see OrderingResult.cost_axis); `guesses` and
# `time_s` are the same point in each unit, when that unit was measured.
class MilestoneStat(TypedDict):
    fraction: float
    target: int
    cost: float | None
    guesses: int | None
    time_s: float | None
    after: str | None


# Info of one step (one attack) in a single ordering run
# `cost` is on the ranking's axis; guesses and seconds are present when measured.
class OrderingStep(TypedDict):
    label: str
    cost: float
    cumulative_cost: float
    guesses: NotRequired[int]
    cumulative_guesses: NotRequired[int]
    duration_s: NotRequired[float]
    elapsed_s: NotRequired[float]
    gain: int
    gain_per_cost: float
    cumulative: int
    cumulative_coverage: float
    cumulative_share: float


# Info on the simulation of one specific ordering run
class OrderingSingleRun(TypedDict):
    order: list[str]
    auc: float
    efficiency: float
    steps: list[OrderingStep]
    milestones: list[MilestoneStat]


# A signature is a certain subset of attacks which recovers a certain number of passwords.
class OrderingSignature(TypedDict):
    labels: list[str]
    count: int
    share: float


# A top contender for a first attack to run
class OrderingFirstChoice(TypedDict):
    label: str
    efficiency: float
    order: list[str]


# Aggregated results of 'the ordering analysis'
class OrderingResult(JobResultBase[OrderingAttackResult]):
    # What the score integrates over: "guesses", or "time" / "equal" as fallbacks
    cost_axis: str
    total_guesses: int | None
    total_runtime_s: float | None
    permutations_scored: int
    timing_available: bool
    milestone_fractions: list[float]
    best: OrderingSingleRun
    worst: OrderingSingleRun
    greedy: dict[str, object]
    top: list[dict[str, object]]
    first_choice: list[OrderingFirstChoice]
    distribution: OrderingDistribution
    signatures: list[OrderingSignature]


class FinalAttackResult(AttackResult):
    mode: str
    partial: bool
    exit_code: int
    wordlist: str | None
    rules: list[str]
    mask: str | None
    # Set in worker/main.py::finalize. `suspect` = this attack's wordlist was
    # flagged as possibly derived from the goal; `contaminated` = how many
    # verbatim goal hits were set aside (0 unless suspect).
    suspect: bool
    contaminated: int


class FinalJobResult(JobResultBase[FinalAttackResult]):
    kind: str
    goal: str
    goal_rejected: int
    partial: bool
    warmup_s: dict[str, float]
    max_runtime_s: int | None
    hashcat_version: str
    started_at: float
    finished_at: float
    duration_s: float
    partial_note: NotRequired[str]
    # Goal words set aside across all attacks as verbatim dictionary
    # contamination, and the suspect wordlists that triggered it.
    contaminated_total: int
    suspect_wordlists: list[str]
    # Ordering specific
    cost_axis: NotRequired[str]
    total_guesses: NotRequired[int | None]
    total_runtime_s: NotRequired[float | None]
    permutations_scored: NotRequired[int]
    timing_available: NotRequired[bool]
    milestone_fractions: NotRequired[list[float]]
    best: NotRequired[OrderingSingleRun]
    worst: NotRequired[OrderingSingleRun]
    greedy: NotRequired[dict[str, object]]
    top: NotRequired[list[dict[str, object]]]
    first_choice: NotRequired[list[OrderingFirstChoice]]
    distribution: NotRequired[OrderingDistribution]
    signatures: NotRequired[list[OrderingSignature]]
    # Mergeability specific
    pairs: NotRequired[list[PairStats]]
