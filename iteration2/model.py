from __future__ import annotations

import config


#Embedding implementation placeholder.
def get_model(model_key: str = config.MODEL_KEY):
    raise NotImplementedError("No embedding model is configured.")


def embed_texts(model, texts: list[str]):
    raise NotImplementedError("No embedding function is configured.")


def model_revision(model) -> str:
    return "MODEL_REVISION_PLACEHOLDER"
