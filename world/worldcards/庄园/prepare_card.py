"""Prepare the existing manor card for the current SR package protocol.

This module is deliberately filesystem/network independent. Resource downloading,
URI replacement and ZIP construction belong to the caller.
"""

from __future__ import annotations

from copy import deepcopy
import re
from typing import Any


_ASSET_IMAGE_ID = "AssetImage"
_ASSET_IMAGE_IMPORT = "import AssetImage from './AssetImage';"
_ASSET_IMAGE_SOURCE = """import React from 'react';
import { useSRAssetUrl } from '@sillyrealms/sdk';

export default function AssetImage({
  src,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const resolvedSrc = useSRAssetUrl(src || null);
  return <img {...props} src={resolvedSrc ?? undefined} />;
}
"""

_FIELD_RULE = "保持原有字段含义和数据类型；仅依据本轮已发生且可确认的事实更新，不把计划、猜测或行动建议写成事实。"
_ARRAY_RULE = "保持原有条目结构；仅记录已经发生且可确认的条目变化，不提前执行计划或建议。"


def _cover_rules(value: Any, path: str, rules: dict[str, str]) -> None:
    """Cover the union of initial values and every opening override."""
    rules.setdefault(path, _FIELD_RULE)
    if isinstance(value, dict):
        for key, child in value.items():
            _cover_rules(child, path + "." + key, rules)
    elif isinstance(value, list):
        element_path = path + "[]"
        rules.setdefault(element_path, _ARRAY_RULE)
        for child in value:
            _cover_rules(child, element_path, rules)


def _prepare_state(data: dict[str, Any]) -> None:
    state = data.get("state")
    if state is None:
        return
    if state.get("schema_version") not in (1, 2):
        raise ValueError("Only manor state schema versions 1 and 2 are supported")
    for scope, definitions in state["scopes"].items():
        for root, definition in definitions.items():
            # Preserve existing author rules if the module is called repeatedly.
            rules = dict(definition.get("rules") or {})
            rules.setdefault(root, definition["description"])
            _cover_rules(definition["initial"], root, rules)
            if scope == "message":
                for opening in data["openings"]:
                    overrides = opening.get("initial_state", {})
                    if root in overrides:
                        _cover_rules(overrides[root], root, rules)
            definition["rules"] = rules
    state["schema_version"] = 2


def _prepare_images(data: dict[str, Any]) -> None:
    components = data.setdefault("components", [])
    declared = next((item for item in components if item["id"] == _ASSET_IMAGE_ID), None)
    if declared is not None and declared.get("component") != _ASSET_IMAGE_SOURCE:
        raise ValueError("AssetImage component ID is already used by another component")

    used = declared is not None
    for item in components:
        if item["id"] == _ASSET_IMAGE_ID:
            continue
        source = item.get("component")
        if source is None:
            raise ValueError("prepare_card expects the original inline manor components")
        source, count = re.subn(r"<img\b", "<AssetImage", source)
        if count:
            source = re.sub(r"</img\s*>", "</AssetImage>", source)
            if _ASSET_IMAGE_IMPORT not in source:
                source = _ASSET_IMAGE_IMPORT + "\n" + source
            item["component"] = source
            used = True
    if used and declared is None:
        components.append({"id": _ASSET_IMAGE_ID, "component": _ASSET_IMAGE_SOURCE})


def prepare_card(card: dict) -> dict:
    """Return a deep copy with state v2 rules and SDK-resolved image elements.

    Names, character material, lore, openings, initial state values, message
    rules and existing component behavior are preserved. Existing state hooks
    already use the current tuple/message-scope contract, and WorldStage already
    renders SR.WorldStory with its supported showState prop.
    """
    prepared = deepcopy(card)
    data = prepared["data"]
    _prepare_state(data)
    _prepare_images(data)
    return prepared
