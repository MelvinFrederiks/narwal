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


# Mergability
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
class MergabilityResult(JobResultBase[AttackResult]):
    pairs: list[PairStats]


# Ordering
class OrderingAttackResult(AttackResult):
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
class MilestoneStat(TypedDict):
    fraction: float
    target: int
    time_s: float | None
    after: str | None


# Info of one step (one attack) in a single ordering run
class OrderingStep(TypedDict):
    label: str
    duration_s: float
    elapsed_s: float
    gain: int
    gain_rate: float
    cumulative: int
    cumulative_coverage: float
    cumulative_share: float


# Info on the simulation of one specific ordering run
class OrderingSingleRun(TypedDict):
    order: list
    auc: float
    efficiency: float
    steps: list
    milestones: list[MilestoneStat]
    is_optimal: NotRequired[bool]
    beaten_by: NotRequired[int]


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
    total_runtime_s: float | None
    permutations_scored: int
    timing_available: bool
    milestone_fractions: list[float]
    best: OrderingSingleRun
    worst: OrderingSingleRun
    greedy: OrderingSingleRun
    top: list[OrderingSingleRun]
    first_choice: list[OrderingFirstChoice]
    distribution: OrderingDistribution
    signatures: list[OrderingSignature]
