"""ADR-025 Phase 1a: ``git_provider`` resolution and its survival across every hop.

The orchestrator → agent payload reaches ``build_config`` three ways:

* AgentCore ``/invocations`` and MicroVM ``/run``:
  ``_extract_invocation_params`` → ``_run_task_background`` → ``run_task``;
* ECS: ``run_task_from_payload`` → ``run_task``.

Hand-written mappers on these hops have dropped fields before (#596), so each
hop has a test here, plus a structural test that the explicit ``run_task(...)``
call in ``_run_task_background`` forwards every parameter it receives.
"""

from __future__ import annotations

import ast
import inspect
import json
import textwrap
from pathlib import Path
from typing import Any, get_args
from unittest.mock import MagicMock, patch

import pytest

import server
from config import build_config
from git_provider import (
    DEFAULT_GIT_PROVIDER,
    GIT_PROVIDER_VOCABULARY,
    IMPLEMENTED_GIT_PROVIDERS,
    UnsupportedGitProviderError,
    resolve_git_provider,
)
from models import TaskConfig
from pipeline import run_task, run_task_from_payload
from workflow.models import VcsProvider

_CONSTANTS_JSON = Path(__file__).resolve().parents[2] / "contracts" / "constants.json"
_NON_GITHUB_PROVIDERS = [p for p in get_args(VcsProvider) if p != "github"]

# Parameters ``_run_task_background`` consumes itself and must NOT forward to
# ``run_task``: the AgentCore session id (OTEL correlation) and the workload
# access token (ContextVar bridge). Both are read in the background thread.
_BACKGROUND_ONLY_PARAMS = frozenset({"session_id", "workload_access_token"})


class _FakeRequest:
    """Minimal stand-in for starlette.Request — only ``.headers.get`` is used."""

    def __init__(self) -> None:
        self.headers: dict[str, str] = {}


def _base_config_kwargs(**extra: Any) -> dict[str, Any]:
    return {
        "repo_url": "owner/repo",
        "task_description": "fix bug",
        "github_token": "ghp_test123",
        "aws_region": "us-east-1",
        **extra,
    }


class TestContract:
    def test_implemented_is_subset_of_vcs_provider_literal(self):
        assert set(get_args(VcsProvider)) >= IMPLEMENTED_GIT_PROVIDERS

    def test_implemented_is_subset_of_contract_vocabulary(self):
        contract = json.loads(_CONSTANTS_JSON.read_text())["git_providers"]
        assert set(contract["vocabulary"]) >= set(contract["implemented"])
        assert set(contract["implemented"]) == IMPLEMENTED_GIT_PROVIDERS
        assert contract["default"] == DEFAULT_GIT_PROVIDER

    def test_contract_vocabulary_matches_vcs_provider_literal(self):
        # The vocabulary IS the ADR-014 VcsProvider (ADR-025 §1).
        assert set(GIT_PROVIDER_VOCABULARY) == set(get_args(VcsProvider))

    def test_default_is_github_and_implemented(self):
        assert DEFAULT_GIT_PROVIDER == "github"
        assert DEFAULT_GIT_PROVIDER in IMPLEMENTED_GIT_PROVIDERS


class TestResolveGitProvider:
    def test_none_means_github(self):
        assert resolve_git_provider(None) == "github"

    def test_github_accepted(self):
        assert resolve_git_provider("github") == "github"

    @pytest.mark.parametrize("value", _NON_GITHUB_PROVIDERS)
    def test_vocabulary_but_unimplemented_raises(self, value):
        # Pins every allowed-by-schema-but-unimplemented value: none may slip
        # through to act against github.com.
        expected = f"unsupported git_provider '{value}'"
        with pytest.raises(UnsupportedGitProviderError, match=expected):
            resolve_git_provider(value)

    @pytest.mark.parametrize(
        "value",
        [
            "",
            "GitHub",
            "GITHUB",
            " github",
            "github ",
            "bogus",
            123,
            0,
            False,
            True,
            [],
            {},
            ["github"],
        ],
    )
    def test_malformed_raises_without_coercion(self, value):
        with pytest.raises(UnsupportedGitProviderError) as exc_info:
            resolve_git_provider(value)
        assert str(exc_info.value) == f"unsupported git_provider {value!r}"

    def test_error_is_a_value_error(self):
        # build_config and its callers already treat ValueError as a config failure.
        assert issubclass(UnsupportedGitProviderError, ValueError)


class TestTaskConfigField:
    def test_defaults_to_github(self):
        cfg = TaskConfig(repo_url="o/r", aws_region="us-east-1")
        assert cfg.git_provider == "github"

    def test_rejects_value_outside_vocabulary(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            TaskConfig(repo_url="o/r", aws_region="us-east-1", git_provider="bogus")  # ty: ignore[invalid-argument-type]


class TestBuildConfig:
    def test_absent_means_github(self):
        assert build_config(**_base_config_kwargs()).git_provider == "github"

    def test_explicit_none_means_github(self):
        assert build_config(**_base_config_kwargs(git_provider=None)).git_provider == "github"

    def test_github_stored(self):
        assert build_config(**_base_config_kwargs(git_provider="github")).git_provider == "github"

    @pytest.mark.parametrize("value", [*_NON_GITHUB_PROVIDERS, "", "GitHub", "bogus", 7])
    def test_unsupported_raises_before_side_effects(self, value):
        # build_config must not read the platform GitHub secret for a non-GitHub
        # provider (ADR-025 §4), and nothing may run before the raise. This holds
        # on the ECS/local paths only; the server path reads it earlier (see
        # TestAgentCoreMicroVmHop.test_server_path_still_resolves_token_...).
        with (
            patch("config.resolve_github_token") as token,
            pytest.raises(ValueError, match="unsupported git_provider"),
        ):
            build_config(**_base_config_kwargs(github_token="", git_provider=value))
        token.assert_not_called()

    def test_unsupported_error_does_not_claim_missing_token(self):
        with (
            patch("config.resolve_github_token", return_value=""),
            pytest.raises(ValueError) as exc_info,
        ):
            build_config(**_base_config_kwargs(github_token="", git_provider="gitlab"))
        assert "github_token is required" not in str(exc_info.value)

    def test_unsupported_reported_alongside_other_errors(self):
        # Validated INSIDE the shared errors list, not as a separate early exit.
        with pytest.raises(ValueError) as exc_info:
            build_config(**_base_config_kwargs(aws_region="", git_provider="gitlab"))
        msg = str(exc_info.value)
        assert "unsupported git_provider 'gitlab'" in msg
        assert "aws_region is required" in msg

    def test_workflow_provider_mismatch_raises(self):
        import workflow

        real = workflow.load_workflow("coding/new-task-v1")
        assert real.repo_config is not None
        gitlab_wf = real.model_copy(
            update={"repo_config": real.repo_config.model_copy(update={"provider": "gitlab"})}
        )
        with (
            patch("workflow.load_workflow", return_value=gitlab_wf),
            pytest.raises(
                ValueError, match="workflow requires git_provider 'gitlab', repo is 'github'"
            ),
        ):
            build_config(**_base_config_kwargs(git_provider="github"))

    def test_workflow_provider_mismatch_raises_when_payload_absent(self):
        # The workflow value is a constraint, never a source: an absent payload
        # resolves to github and is checked against it, not replaced by it.
        import workflow

        real = workflow.load_workflow("coding/new-task-v1")
        assert real.repo_config is not None
        gitlab_wf = real.model_copy(
            update={"repo_config": real.repo_config.model_copy(update={"provider": "gitlab"})}
        )
        with (
            patch("workflow.load_workflow", return_value=gitlab_wf),
            pytest.raises(ValueError, match="workflow requires git_provider 'gitlab'"),
        ):
            build_config(**_base_config_kwargs())

    def test_matching_workflow_provider_passes(self):
        import workflow

        wf = workflow.load_workflow("coding/new-task-v1")
        assert wf.repo_config is not None and wf.repo_config.provider == "github"
        assert build_config(**_base_config_kwargs(git_provider="github")).git_provider == "github"

    @pytest.mark.parametrize("value", [None, "github"])
    def test_repo_less_workflow_unaffected(self, value):
        # Rule 7 forbids repo_config.provider on repo-less workflows; resolving
        # an absent/default payload value must not break them.
        cfg = build_config(
            task_description="research x",
            aws_region="us-east-1",
            resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
            git_provider=value,
        )
        assert cfg.requires_repo is False
        assert cfg.git_provider == "github"


class TestAgentCoreMicroVmHop:
    """``_extract_invocation_params`` serves both AgentCore and MicroVM ``/run``."""

    def _extract(self, **extra: Any) -> dict:
        payload = {"repo_url": "org/repo", "task_description": "x", "task_id": "t-1", **extra}
        fake: Any = _FakeRequest()
        return server._extract_invocation_params(payload, fake)

    def test_round_trip(self):
        assert self._extract(git_provider="github")["git_provider"] == "github"

    def test_absent_is_none(self):
        assert self._extract()["git_provider"] is None

    @pytest.mark.parametrize("value", [123, "", "GitHub", " github", ["github"], False])
    def test_raw_passthrough_without_coercion(self, value):
        # build_config owns validation; the extractor must not "fix" a bad value.
        out = self._extract(git_provider=value)["git_provider"]
        assert out == value
        assert type(out) is type(value)

    def test_server_path_still_resolves_token_for_unsupported_provider(self):
        """PINS today's (known-imperfect) AgentCore/MicroVM behaviour.

        ``_extract_invocation_params`` resolves the GitHub token before
        ``build_config`` resolves the provider, so the platform secret IS read for
        an unsupported provider on this path. Phase 1a keeps server.py additive;
        TODO(ADR-025 Phase 2 §4) moves token resolution after provider resolution
        and must flip this test deliberately (assert_not_called).
        """
        with patch.object(server, "resolve_github_token", return_value="ghp_x") as token:
            out = self._extract(git_provider="gitlab")
        token.assert_called_once()
        assert out["github_token"] == token.return_value
        assert out["git_provider"] == "gitlab"

    def test_extracted_params_bind_to_background_signature(self):
        inspect.signature(server._run_task_background).bind(**self._extract(git_provider="github"))

    def test_background_forwards_every_param_to_run_task(self):
        """Structural lock on the hop no test covered: every ``_run_task_background``
        parameter (except the ones it consumes itself) must appear in its explicit
        ``run_task(...)`` call as ``name=name``. Adding a param on one side only —
        how ``base_branch`` was dropped before — fails here."""
        bg_params = set(inspect.signature(server._run_task_background).parameters)
        tree = ast.parse(textwrap.dedent(inspect.getsource(server._run_task_background)))
        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "run_task"
        ]
        assert len(calls) == 1, "expected exactly one run_task(...) call"
        (call,) = calls
        assert not call.args, "run_task must be called with keywords only"
        forwarded: dict[str, str | None] = {}
        for kw in call.keywords:
            assert kw.arg is not None, "run_task(**...) would defeat this check"
            forwarded[kw.arg] = kw.value.id if isinstance(kw.value, ast.Name) else None

        missing = bg_params - _BACKGROUND_ONLY_PARAMS - set(forwarded)
        assert not missing, f"_run_task_background drops params before run_task: {sorted(missing)}"
        renamed = {k: v for k, v in forwarded.items() if v != k}
        assert not renamed, f"run_task kwargs not forwarded as name=name: {renamed}"
        unknown = set(forwarded) - set(inspect.signature(run_task).parameters)
        assert not unknown, f"run_task does not accept: {sorted(unknown)}"
        leaked = set(forwarded) & _BACKGROUND_ONLY_PARAMS
        assert not leaked, f"background-only params leaked to run_task: {sorted(leaked)}"

    def test_background_passes_git_provider_to_run_task(self):
        params = self._extract(git_provider="github")
        params["task_id"] = ""  # no heartbeat thread
        with (
            patch.object(server, "run_task") as fake_run_task,
            patch.object(server, "propagate_correlation_context"),
        ):
            server._run_task_background(**params)
        fake_run_task.assert_called_once()
        assert fake_run_task.call_args.kwargs["git_provider"] == "github"

    def test_background_passes_malformed_value_unchanged(self):
        params = self._extract(git_provider="gitlab")
        params["task_id"] = ""
        with (
            patch.object(server, "run_task") as fake_run_task,
            patch.object(server, "propagate_correlation_context"),
        ):
            server._run_task_background(**params)
        assert fake_run_task.call_args.kwargs["git_provider"] == "gitlab"


class TestEcsHop:
    def _capture(self, payload: dict) -> dict:
        seen: dict = {}

        def fake_run_task(**kwargs):
            seen.update(kwargs)
            return {"status": "success"}

        with patch("pipeline.run_task", side_effect=fake_run_task):
            run_task_from_payload(payload)
        return seen

    def test_forwards_git_provider(self):
        assert self._capture({"git_provider": "github"})["git_provider"] == "github"

    def test_forwards_malformed_value_unchanged(self):
        assert self._capture({"git_provider": "gitlab"})["git_provider"] == "gitlab"

    def test_none_dropped_so_default_applies(self):
        assert "git_provider" not in self._capture({"git_provider": None})

    def test_none_reaches_build_config_as_default_github(self):
        # Real run_task, build_config intercepted after it resolves the value.
        seen: dict = {}

        def fake_build_config(**kwargs):
            seen.update(kwargs)
            raise RuntimeError("stop after build_config")

        with (
            patch("pipeline.build_config", side_effect=fake_build_config),
            pytest.raises(RuntimeError, match="stop after build_config"),
        ):
            run_task_from_payload({"git_provider": None, "repo_url": "o/r"})
        assert seen["git_provider"] is None
        assert resolve_git_provider(seen["git_provider"]) == "github"

    def test_real_run_task_passes_git_provider_to_build_config(self):
        seen: dict = {}

        def fake_build_config(**kwargs):
            seen.update(kwargs)
            raise RuntimeError("stop after build_config")

        with (
            patch("pipeline.build_config", side_effect=fake_build_config),
            pytest.raises(RuntimeError, match="stop after build_config"),
        ):
            run_task_from_payload({"git_provider": "github", "repo_url": "o/r"})
        assert seen["git_provider"] == "github"


class TestEndToEndFailClosed:
    @pytest.mark.parametrize("value", ["gitlab", "GitHub", ""])
    def test_run_task_unsupported_never_clones(self, value):
        setup_repo = MagicMock(name="setup_repo")
        with (
            patch("repo.setup_repo", setup_repo),
            patch("config.resolve_github_token") as token,
            pytest.raises(ValueError, match="unsupported git_provider"),
        ):
            run_task(
                repo_url="owner/repo",
                task_description="x",
                github_token="",
                aws_region="us-east-1",
                git_provider=value,
            )
        setup_repo.assert_not_called()
        token.assert_not_called()

    def test_ecs_payload_unsupported_never_clones(self):
        setup_repo = MagicMock(name="setup_repo")
        with (
            patch("repo.setup_repo", setup_repo),
            pytest.raises(ValueError, match="unsupported git_provider 'gitlab'"),
        ):
            run_task_from_payload(
                {
                    "repo_url": "owner/repo",
                    "prompt": "x",
                    "github_token": "ghp_x",
                    "aws_region": "us-east-1",
                    "git_provider": "gitlab",
                }
            )
        setup_repo.assert_not_called()
