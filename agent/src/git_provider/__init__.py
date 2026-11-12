"""Git provider resolution (ADR-025 Phase 1a).

The repo row is the only authority for ``git_provider`` (ADR-025 §1). The
orchestrator resolves it and sends it as a top-level payload key; the agent
re-validates it here before any clone or other repository side effect (§9).

Phase 1a ships only the resolver. The ``GitProvider`` Protocol and the GitHub
implementation arrive in Phase 1c.
"""

from __future__ import annotations

from typing import cast, get_args

from shared_constants import SHARED_CONSTANTS
from workflow.models import VcsProvider

# Sourced from contracts/constants.json, not re-declared (checked by
# scripts/check-constants-sync.ts).
_GIT_PROVIDERS_CONTRACT = SHARED_CONSTANTS["git_providers"]
GIT_PROVIDER_VOCABULARY: tuple[str, ...] = tuple(_GIT_PROVIDERS_CONTRACT["vocabulary"])
IMPLEMENTED_GIT_PROVIDERS: frozenset[str] = frozenset(_GIT_PROVIDERS_CONTRACT["implemented"])

# Import-time invariants: the implemented list is the fail-closed allowlist, so a
# contract that names an id outside the ADR-014 VcsProvider Literal (or a default
# that is not implemented) must stop the agent from booting, not widen it.
if not set(GIT_PROVIDER_VOCABULARY) <= set(get_args(VcsProvider)):
    raise ValueError("contracts/constants.json git_providers.vocabulary must be VcsProvider ids")
if not set(GIT_PROVIDER_VOCABULARY) >= IMPLEMENTED_GIT_PROVIDERS:
    raise ValueError("contracts/constants.json git_providers.implemented must be within vocabulary")
if _GIT_PROVIDERS_CONTRACT["default"] not in IMPLEMENTED_GIT_PROVIDERS:
    raise ValueError("contracts/constants.json git_providers.default must be implemented")

# Safe: checked above to be an implemented VcsProvider id.
DEFAULT_GIT_PROVIDER: VcsProvider = cast("VcsProvider", _GIT_PROVIDERS_CONTRACT["default"])


class UnsupportedGitProviderError(ValueError):
    """``git_provider`` is not an implemented provider id."""


def resolve_git_provider(value: object) -> VcsProvider:
    """Return the implemented provider id for a payload ``git_provider`` value.

    ``None`` means the default (``github``): the ECS path drops ``None`` and
    AgentCore cannot tell JSON ``null`` from absent, so both reach here as
    ``None`` for payloads from before Phase 1a (ADR-025 §1).

    Anything else must match an implemented id exactly — no case folding, no
    trimming, no coercion of non-strings, and no fallback.

    Raises:
        UnsupportedGitProviderError: ``value`` is not ``None`` and not an
            implemented provider id.
    """
    if value is None:
        return DEFAULT_GIT_PROVIDER
    if isinstance(value, str) and value in IMPLEMENTED_GIT_PROVIDERS:
        # Safe: IMPLEMENTED_GIT_PROVIDERS is checked at import to be VcsProvider ids.
        return cast("VcsProvider", value)
    raise UnsupportedGitProviderError(f"unsupported git_provider {value!r}")


__all__ = [
    "DEFAULT_GIT_PROVIDER",
    "GIT_PROVIDER_VOCABULARY",
    "IMPLEMENTED_GIT_PROVIDERS",
    "UnsupportedGitProviderError",
    "resolve_git_provider",
]
