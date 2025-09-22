#!/usr/bin/env python3
"""Generate hierarchical topics using BERTopic with supplied embeddings.

Reads JSON from stdin with fields:
  documents: [{"id": int, "text": str}]
  embeddings: [[float, ...], ...]  # optional
  params: {
    "umap": {...},
    "hdbscan": {...},
    "vectorizer": {...},
    "top_n_terms": int,
    "min_topic_size": int,
    "nr_topics": int | None
  }

Outputs JSON with keys:
  topics: [
    {
      "topic_id": int,
      "parent_id": int | null,
      "level": int,
      "label": str,
      "size": int,
      "score": float | null,
      "terms": [{"term": str, "score": float, "rank": int}],
      "docs": [{"id": int, "weight": float}],
      "centroid": [float, ...]
    }
  ]
  meta: {"nr_topics": int, "outliers": int}
"""

import json
import math
import numbers
import os
import sys
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
import re


def _to_int(val: Any) -> Optional[int]:
    if val is None:
        return None
    if isinstance(val, numbers.Integral):
        return int(val)
    if isinstance(val, float):
        if math.isnan(val):
            return None
        return int(val)
    s = str(val)
    m = re.search(r"(-?\d+)$", s.strip())
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    m = re.search(r"(-?\d+)", s)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    try:
        return int(val)
    except Exception:
        return None



def _fail(msg: str, code: int = 1) -> None:
    payload = {"error": msg}
    sys.stdout.write(json.dumps(payload))
    sys.exit(code)


try:
    import numpy as np
except Exception as exc:  # noqa: BLE001
    _fail(f"numpy import failed: {exc}")

try:
    import sqlite3
except Exception as exc:  # noqa: BLE001
    _fail(f"sqlite3 import failed: {exc}")

try:
    from sklearn.feature_extraction.text import CountVectorizer
except Exception as exc:  # noqa: BLE001
    _fail(f"scikit-learn import failed: {exc}")

try:
    from umap import UMAP
except Exception as exc:  # noqa: BLE001
    _fail(f"umap import failed: {exc}")

try:
    import hdbscan
except Exception as exc:  # noqa: BLE001
    _fail(f"hdbscan import failed: {exc}")

try:
    from bertopic import BERTopic
except Exception as exc:  # noqa: BLE001
    _fail(f"bertopic import failed: {exc}")

try:
    from bertopic.representation import KeyBERTInspired, MaximalMarginalRelevance, PartOfSpeech, OpenAI
except Exception:
    KeyBERTInspired = None  # type: ignore[assignment]
    MaximalMarginalRelevance = None  # type: ignore[assignment]
    PartOfSpeech = None  # type: ignore[assignment]
    OpenAI = None  # type: ignore[assignment]

try:
    import openai  # type: ignore[import]
except Exception:
    openai = None  # type: ignore[assignment]


def read_input() -> Dict[str, Any]:
    try:
        raw = sys.stdin.read()
        return json.loads(raw or '{}')
    except json.JSONDecodeError as exc:
        _fail(f"invalid json input: {exc}")
        raise


def build_topic_model(params: Dict[str, Any]) -> BERTopic:
    umap_defaults = {
        'n_neighbors': 15,
        'n_components': 15,
        'min_dist': 0.0,
        'metric': 'cosine',
        'random_state': 42,
    }
    hdbscan_defaults = {
        'min_cluster_size': 8,
        'min_samples': None,
        'metric': 'euclidean',
        'cluster_selection_method': 'eom',
        'prediction_data': True,
    }
    vectorizer_defaults = {
        'ngram_range': (1, 3),
        'min_df': 1,
        'max_features': None,
        'stop_words': None,
    }

    umap_conf = {**umap_defaults, **(params.get('umap') or {})}
    hdbscan_conf = {**hdbscan_defaults, **(params.get('hdbscan') or {})}
    vectorizer_conf = {**vectorizer_defaults, **(params.get('vectorizer') or {})}
    if isinstance(vectorizer_conf.get('ngram_range'), list):
        rng = vectorizer_conf['ngram_range']
        if len(rng) == 2:
            vectorizer_conf['ngram_range'] = (int(rng[0]), int(rng[1]))

    umap_model = UMAP(**umap_conf)
    hdbscan_model = hdbscan.HDBSCAN(**hdbscan_conf)
    vectorizer_model = CountVectorizer(**vectorizer_conf)

    representation = None
    if isinstance(params, dict) and params.get('representation'):
        representation = resolve_representation_model(params.get('representation'))

    topic_model = BERTopic(
        umap_model=umap_model,
        hdbscan_model=hdbscan_model,
        vectorizer_model=vectorizer_model,
        calculate_probabilities=True,
        verbose=False,
        top_n_words=params.get('top_n_terms', 10),
        nr_topics=params.get('nr_topics'),
        min_topic_size=params.get('min_topic_size', hdbscan_conf['min_cluster_size']),
        representation_model=representation,
    )
    return topic_model


def load_embeddings_from_db(ids: List[int], db_path: str, backend: str, model: str) -> np.ndarray:
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
    except Exception as exc:  # noqa: BLE001
        _fail(f"failed opening embeddings db: {exc}")

    id_to_index = {int(note_id): idx for idx, note_id in enumerate(ids)}
    dim = None
    embeddings = None
    found = set()
    try:
        batch_size = 900
        processed = 0
        total = len(ids)
        for start in range(0, len(ids), batch_size):
            batch = ids[start:start + batch_size]
            if not batch:
                continue
            placeholders = ','.join(['?'] * len(batch))
            query = (
                f"SELECT note_id, vec, dim FROM embeddings2 "
                f"WHERE backend = ? AND model = ? AND note_id IN ({placeholders})"
            )
            params = [backend, model, *batch]
            cursor = conn.execute(query, params)
            for row in cursor.fetchall():
                note_id = int(row['note_id'])
                vec = row['vec']
                row_dim = int(row['dim'] or 0)
                arr = np.frombuffer(vec, dtype=np.float32)
                if dim is None:
                    dim = row_dim if row_dim > 0 else arr.shape[0]
                    embeddings = np.zeros((len(ids), dim), dtype=np.float32)
                if embeddings is None:
                    continue
                if arr.shape[0] != dim:
                    arr = arr[:dim]
                idx = id_to_index.get(note_id)
                if idx is None:
                    continue
                embeddings[idx, :arr.shape[0]] = arr
                found.add(note_id)
            processed += len(batch)
            print(json.dumps({
                'type': 'embedding_progress',
                'completed': processed,
                'total': total,
            }), flush=True)
    finally:
        conn.close()

    if embeddings is None:
        _fail('No embeddings fetched from database.')

    missing = [note_id for note_id in ids if note_id not in found]
    if missing:
        print(json.dumps({
            'warning': 'missing_embeddings',
            'count': len(missing),
        }), file=sys.stderr)
    return embeddings


def _maybe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def _maybe_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except Exception:
        return None


def resolve_representation_model(config: Dict[str, Any] | None) -> Any:
    if not config or not isinstance(config, dict):
        return None

    rtype = str(config.get('type') or '').strip().lower()
    if not rtype:
        return None

    if rtype in {'local', 'keybert', 'keybert_inspired'}:
        if KeyBERTInspired is None:
            print(json.dumps({'type': 'warning', 'message': 'KeyBERT representation requested but unavailable; using default c-TF-IDF labels'}), flush=True)
            return None
        kwargs: Dict[str, Any] = {}
        for key in ('top_n_words', 'nr_repr_docs', 'nr_samples', 'nr_candidate_words', 'random_state'):
            val = _maybe_int(config.get(key))
            if val is not None:
                kwargs[key] = val
        return KeyBERTInspired(**kwargs)

    if rtype in {'mmr', 'maximal_marginal_relevance'}:
        if MaximalMarginalRelevance is None:
            print(json.dumps({'type': 'warning', 'message': 'MMR representation requested but unavailable; using default c-TF-IDF labels'}), flush=True)
            return None
        kwargs: Dict[str, Any] = {}
        diversity = _maybe_float(config.get('diversity'))
        if diversity is not None:
            kwargs['diversity'] = max(0.0, min(1.0, diversity))
        top_n = _maybe_int(config.get('top_n_words'))
        if top_n is not None and top_n > 0:
            kwargs['top_n_words'] = top_n
        return MaximalMarginalRelevance(**kwargs)

    if rtype in {'pos', 'part_of_speech'}:
        if PartOfSpeech is None:
            print(json.dumps({'type': 'warning', 'message': 'SpaCy POS representation requested but spaCy is not installed; using default c-TF-IDF labels'}), flush=True)
            return None
        kwargs: Dict[str, Any] = {}
        model_name = config.get('model')
        if isinstance(model_name, str) and model_name.strip():
            kwargs['model'] = model_name.strip()
        top_n = _maybe_int(config.get('top_n_words'))
        if top_n is not None and top_n > 0:
            kwargs['top_n_words'] = top_n
        if isinstance(config.get('pos_patterns'), list):
            kwargs['pos_patterns'] = config['pos_patterns']
        return PartOfSpeech(**kwargs)

    if rtype in {'openai', 'gpt', 'chatgpt', 'llm'}:
        if OpenAI is None or openai is None:
            print(json.dumps({'type': 'warning', 'message': 'OpenAI representation requested but dependencies are missing; using default c-TF-IDF labels'}), flush=True)
            return None

        api_key = str(config.get('api_key') or os.environ.get('OPENAI_API_KEY') or '').strip()
        if not api_key:
            print(json.dumps({'type': 'warning', 'message': 'OpenAI representation requested but no API key provided; using default c-TF-IDF labels'}), flush=True)
            return None

        client_kwargs: Dict[str, Any] = {'api_key': api_key}
        base_url = config.get('api_base') or config.get('base_url')
        if isinstance(base_url, str) and base_url.strip():
            client_kwargs['base_url'] = base_url.strip()

        try:
            client = openai.OpenAI(**client_kwargs)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({'type': 'warning', 'message': f'Failed to initialize OpenAI client: {exc}'}), flush=True)
            return None

        kwargs: Dict[str, Any] = {}
        model_name = config.get('model')
        if isinstance(model_name, str) and model_name.strip():
            kwargs['model'] = model_name.strip()

        for key in ('prompt', 'system_prompt'):
            val = config.get(key)
            if isinstance(val, str) and val.strip():
                kwargs[key] = val

        delay = _maybe_float(config.get('delay_in_seconds'))
        if delay is not None and delay >= 0:
            kwargs['delay_in_seconds'] = delay

        if 'exponential_backoff' in config:
            kwargs['exponential_backoff'] = bool(config.get('exponential_backoff'))

        nr_docs = _maybe_int(config.get('nr_docs'))
        if nr_docs is not None and nr_docs > 0:
            kwargs['nr_docs'] = nr_docs

        doc_length = _maybe_int(config.get('doc_length'))
        if doc_length is not None and doc_length > 0:
            kwargs['doc_length'] = doc_length

        diversity = _maybe_float(config.get('diversity'))
        if diversity is not None:
            kwargs['diversity'] = max(0.0, min(1.0, diversity))

        tokenizer = config.get('tokenizer')
        if tokenizer is not None:
            kwargs['tokenizer'] = tokenizer

        generator_kwargs = config.get('generator_kwargs')
        if isinstance(generator_kwargs, dict):
            # Filter out unsupported parameters that might cause API errors
            supported_params = {'temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty'}
            filtered_kwargs = {k: v for k, v in generator_kwargs.items() if k in supported_params}
            if filtered_kwargs:
                kwargs['generator_kwargs'] = filtered_kwargs
            # Log any filtered parameters for debugging
            filtered_out = set(generator_kwargs.keys()) - set(filtered_kwargs.keys())
            if filtered_out:
                print(json.dumps({'type': 'warning', 'message': f'Filtered unsupported OpenAI parameters: {list(filtered_out)}'}), flush=True)

        model = OpenAI(client=client, **kwargs)
        try:
            if hasattr(model, 'generator_kwargs') and isinstance(model.generator_kwargs, dict):
                model.generator_kwargs.pop('stop', None)
        except Exception:
            pass
        return model

    print(json.dumps({'type': 'warning', 'message': f"Unknown representation type '{rtype}', using default c-TF-IDF labels"}), flush=True)
    return None


def build_topic_tree(
    topic_model: "BERTopic",
    topic_info,
    hierarchy_df,
    topics: Iterable[Any],
    probabilities: Any,
    doc_ids: List[int],
    top_terms: Any,
    hierarchy_conf: Optional[Dict[str, Any]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    try:
        top_count = int(top_terms)
    except Exception:
        top_count = 10
    if top_count <= 0:
        top_count = 10

    max_distance = None
    if hierarchy_conf:
        raw_max_dist = hierarchy_conf.get('max_distance')
        if raw_max_dist not in (None, ''):
            try:
                max_distance = float(raw_max_dist)
            except Exception:
                max_distance = None

    outlier_topic = -1
    topic_assignments = list(topics) if topics is not None else []
    doc_lookup = list(doc_ids)
    doc_members: Dict[int, List[Dict[str, Any]]] = defaultdict(list)

    for idx, assigned in enumerate(topic_assignments):
        topic_id = _to_int(assigned)
        if topic_id is None or topic_id == outlier_topic:
            continue
        if idx >= len(doc_lookup):
            continue
        try:
            note_id = int(doc_lookup[idx])
        except Exception:
            continue
        weight_val = None
        if probabilities is not None:
            try:
                row_probs = probabilities[idx]
                if row_probs is not None:
                    weight_val = float(np.max(row_probs))
            except Exception:
                weight_val = None
        doc_members[topic_id].append({'id': note_id, 'weight': weight_val})

    for entries in doc_members.values():
        entries.sort(key=lambda entry: entry['id'])

    size_by_topic: Dict[int, int] = {}
    prob_by_topic: Dict[int, float] = {}
    label_by_topic: Dict[int, str] = {}

    if topic_info is not None:
        try:
            iterator = topic_info.iterrows()
        except Exception:
            iterator = []
        for _, row in iterator:
            topic_id = _to_int(row.get('Topic'))
            if topic_id is None or topic_id == outlier_topic:
                continue
            count_val = _to_int(row.get('Count'))
            if count_val is not None:
                size_by_topic[topic_id] = max(int(count_val), len(doc_members.get(topic_id, [])))
            name_val = row.get('Name')
            if isinstance(name_val, str) and name_val.strip():
                label_by_topic[topic_id] = name_val.strip()
            prob_val = row.get('Probability')
            if prob_val not in (None, ''):
                try:
                    prob_by_topic[topic_id] = float(prob_val)
                except Exception:
                    pass

    assigned_topics = {topic_id for topic_id in doc_members.keys() if topic_id != outlier_topic}
    leaf_topic_ids = set(size_by_topic.keys()) | assigned_topics
    leaf_topic_ids.discard(outlier_topic)

    nodes: Dict[int, Dict[str, Any]] = {}

    for topic_id in sorted(leaf_topic_ids):
        docs = doc_members.get(topic_id, [])
        size_val = size_by_topic.get(topic_id)
        if size_val is None:
            size_val = len(docs)
        else:
            size_val = max(int(size_val), len(docs))

        label_val = label_by_topic.get(topic_id, f'Topic {topic_id}')
        terms: List[Dict[str, Any]] = []
        topic_terms = []
        try:
            topic_terms = topic_model.get_topic(topic_id) or []
        except KeyError:
            topic_terms = []
        except Exception:
            topic_terms = []
        if isinstance(topic_terms, dict):
            topic_terms = topic_terms.get('Main', [])
        for rank, pair in enumerate(topic_terms, start=1):
            if isinstance(pair, (list, tuple)) and len(pair) >= 2:
                term_text = str(pair[0]).strip()
                if not term_text:
                    continue
                try:
                    score_val = float(pair[1])
                except Exception:
                    score_val = 0.0
                terms.append({'term': term_text, 'score': score_val, 'rank': rank})
            if len(terms) >= top_count:
                break
        if not terms:
            fallback_tokens = [token for token in re.split(r"[_\s]+", label_val) if token]
            for rank, token in enumerate(fallback_tokens[:top_count], start=1):
                terms.append({'term': token, 'score': 0.0, 'rank': rank})

        nodes[topic_id] = {
            'topic_id': topic_id,
            'parent_id': None,
            'level': 0,
            'label': label_val,
            'size': int(size_val),
            'score': prob_by_topic.get(topic_id),
            'terms': terms,
            'docs': docs,
        }

    parent_children: Dict[int, List[int]] = {}
    parent_labels: Dict[int, str] = {}
    children_seen: Set[int] = set()

    if hierarchy_df is not None and getattr(hierarchy_df, 'empty', False) is False:
        try:
            iterator = hierarchy_df.iterrows()
        except Exception:
            iterator = []
        for _, row in iterator:
            parent_id = _to_int(row.get('Parent_ID'))
            left_id = _to_int(row.get('Child_Left_ID'))
            right_id = _to_int(row.get('Child_Right_ID'))
            if parent_id is None or left_id is None or right_id is None:
                continue
            distance_val = row.get('Distance')
            distance = None
            if distance_val not in (None, ''):
                try:
                    distance = float(distance_val)
                except Exception:
                    distance = None
            if max_distance is not None and distance is not None and distance > max_distance:
                continue
            if parent_id in parent_children:
                for child in (left_id, right_id):
                    if child not in parent_children[parent_id]:
                        parent_children[parent_id].append(child)
            else:
                parent_children[parent_id] = [left_id, right_id]
            children_seen.update((left_id, right_id))
            parent_name = row.get('Parent_Name')
            if isinstance(parent_name, str) and parent_name.strip():
                parent_labels[parent_id] = parent_name.strip()

    for parent_id in parent_children:
        node = nodes.get(parent_id)
        if node is None:
            nodes[parent_id] = {
                'topic_id': parent_id,
                'parent_id': None,
                'level': 0,
                'label': parent_labels.get(parent_id, f'Topic {parent_id}'),
                'size': 0,
                'score': None,
                'terms': [],
                'docs': [],
            }
        else:
            if parent_labels.get(parent_id):
                node['label'] = parent_labels[parent_id]
            if node.get('docs'):
                node['docs'] = []

    parent_ids = set(parent_children.keys())
    roots = [pid for pid in parent_ids if pid not in children_seen]
    if not roots and parent_ids:
        roots = [sorted(parent_ids)[-1]]

    def aggregate_terms(child_ids: Iterable[int]) -> List[Dict[str, Any]]:
        score_map: Dict[str, float] = defaultdict(float)
        for child_id in child_ids:
            child = nodes.get(child_id)
            if not child:
                continue
            size_val = child.get('size')
            if size_val is None:
                size_val = len(child.get('docs', []))
            weight = max(int(size_val or 0), 1)
            for term in child.get('terms', []):
                term_key = str(term.get('term') or '').strip()
                if not term_key:
                    continue
                try:
                    score_val = float(term.get('score') or 0.0)
                except Exception:
                    score_val = 0.0
                score_map[term_key] += score_val * weight
        ordered = sorted(score_map.items(), key=lambda kv: kv[1], reverse=True)
        aggregated: List[Dict[str, Any]] = []
        for rank, (term_key, score_val) in enumerate(ordered[:top_count], start=1):
            aggregated.append({'term': term_key, 'score': float(score_val), 'rank': rank})
        return aggregated

    visited: Set[int] = set()

    def walk(node_id: int, level: int) -> int:
        if node_id in visited:
            node = nodes[node_id]
            size_val = node.get('size')
            if size_val is None:
                size_val = len(node.get('docs', []))
            return int(size_val or 0)
        visited.add(node_id)
        node = nodes[node_id]
        node['level'] = int(level)
        children = parent_children.get(node_id, [])
        if not children:
            size_val = node.get('size')
            if size_val is None:
                size_val = len(node.get('docs', []))
            node['size'] = int(size_val or 0)
            return node['size']

        total_size = 0
        for child_id in children:
            if child_id not in nodes:
                nodes[child_id] = {
                    'topic_id': child_id,
                    'parent_id': node_id,
                    'level': level + 1,
                    'label': f'Topic {child_id}',
                    'size': 0,
                    'score': None,
                    'terms': [],
                    'docs': [],
                }
            else:
                nodes[child_id]['parent_id'] = node_id
            child_size = walk(child_id, level + 1)
            total_size += max(int(child_size), 0)

        if not node.get('docs'):
            node['size'] = int(total_size)
        if not node.get('terms'):
            node['terms'] = aggregate_terms(children)

        label_override = parent_labels.get(node_id)
        if label_override:
            node['label'] = label_override
        elif not node.get('label') or node['label'].startswith('Topic '):
            label_terms = [t['term'] for t in node.get('terms', [])[:4] if t.get('term')]
            if label_terms:
                node['label'] = ' '.join(label_terms)
            else:
                node['label'] = f'Topic {node_id}'

        return node.get('size', 0)

    if roots:
        for root_id in roots:
            if root_id in nodes:
                nodes[root_id]['parent_id'] = None
                walk(root_id, 0)
    else:
        for node_id in list(nodes.keys()):
            if node_id not in visited:
                walk(node_id, 0)

    for node in nodes.values():
        docs = node.get('docs') or []
        for doc in docs:
            try:
                doc['id'] = int(doc['id'])
            except Exception:
                pass
            if doc.get('weight') not in (None, ''):
                try:
                    doc['weight'] = float(doc['weight'])
                except Exception:
                    doc['weight'] = None
        if node.get('score') not in (None, ''):
            try:
                node['score'] = float(node['score'])
            except Exception:
                node['score'] = None
        size_val = node.get('size')
        if size_val is None:
            size_val = len(node.get('docs', []))
        node['size'] = int(size_val or 0)
        if node.get('parent_id') is not None:
            node['parent_id'] = int(node['parent_id'])

    ordered_nodes = sorted(nodes.values(), key=lambda item: (item.get('level', 0), item['topic_id']))

    parent_topic_ids = set(parent_children.keys())
    parents_emitted = len([node for node in ordered_nodes if node['topic_id'] in parent_topic_ids])
    stats = {
        'parents_expected': len(parent_topic_ids),
        'parents_emitted': parents_emitted,
        'roots': len(roots),
        'leaf_count': len([node for node in ordered_nodes if node.get('docs')]),
        'max_level': max((node.get('level') or 0) for node in ordered_nodes) if ordered_nodes else 0,
        'has_links': any(node.get('parent_id') is not None for node in ordered_nodes),
    }

    return ordered_nodes, stats


def main() -> None:
    data = read_input()
    docs_payload = data.get('documents') or []
    if not docs_payload:
        _fail('no documents provided')
    texts: List[str] = []
    doc_ids: List[int] = []
    for item in docs_payload:
        try:
            doc_ids.append(int(item['id']))
        except Exception as exc:  # noqa: BLE001
            _fail(f"invalid document id: {exc}")
        texts.append(str(item.get('text') or ''))

    emb_payload = data.get('embeddings')
    embeddings = None
    if emb_payload is not None:
        try:
            embeddings = np.array(emb_payload, dtype=np.float32)
        except Exception as exc:  # noqa: BLE001
            _fail(f"invalid embeddings: {exc}")
        if embeddings.shape[0] != len(texts):
            _fail('embeddings length mismatch')
    else:
        emb_source = data.get('embedding_source') or {}
        db_path = emb_source.get('db_path')
        backend = emb_source.get('backend')
        model = emb_source.get('model')
        if db_path and backend and model:
            embeddings = load_embeddings_from_db(doc_ids, db_path, backend, model)
        else:
            _fail('no embeddings provided and embedding_source incomplete')

    params = data.get('params') or {}

    topic_model = build_topic_model(params)

    print(json.dumps({'type': 'stage', 'stage': 'clustering', 'message': 'Running BERTopic clustering'}), flush=True)

    try:
        topics, probs = topic_model.fit_transform(texts, embeddings=embeddings)
    except Exception as exc:  # noqa: BLE001
        exc_str = str(exc)
        # Provide more helpful error messages for common issues
        if 'unsupported_parameter' in exc_str.lower() and 'stop' in exc_str.lower():
            _fail("bertopic fit failed: The OpenAI model being used doesn't support the 'stop' parameter. Try using a different model like 'gpt-3.5-turbo' or 'gpt-4' instead of the current model.")
        elif 'invalid_request_error' in exc_str.lower():
            _fail(f"bertopic fit failed: OpenAI API request failed. Check your API key and model configuration. Error: {exc}")
        else:
            _fail(f"bertopic fit failed: {exc}")

    print(json.dumps({'type': 'stage', 'stage': 'post_processing', 'message': 'Extracting topic representations'}), flush=True)

    topic_info = topic_model.get_topic_info()

    hierarchy_params = params.get('hierarchy') or {}
    use_ctfidf = hierarchy_params.get('use_ctfidf')
    if not isinstance(use_ctfidf, bool):
        use_ctfidf = True

    linkage_function = None
    hierarchy_linkage = str(hierarchy_params.get('linkage') or '').strip().lower()
    if hierarchy_linkage and hierarchy_linkage != 'ward':
        try:
            from scipy.cluster import hierarchy as sch  # type: ignore

            linkage_function = lambda x, method=hierarchy_linkage: sch.linkage(x, method, optimal_ordering=True)  # noqa: E731
        except Exception as exc:  # noqa: BLE001
            try:
                print(json.dumps({'type': 'warning', 'message': f'hierarchy linkage "{hierarchy_linkage}" unavailable; using ward ({exc})'}), flush=True)
            except Exception:
                pass
            linkage_function = None

    hierarchy_kwargs: Dict[str, Any] = {}
    if linkage_function is not None:
        hierarchy_kwargs['linkage_function'] = linkage_function
    try:
        hierarchy_df = topic_model.hierarchical_topics(texts, use_ctfidf=use_ctfidf, **hierarchy_kwargs)
    except Exception as exc:  # noqa: BLE001
        try:
            print(json.dumps({'type': 'warning', 'message': f'hierarchical_topics failed; proceeding without hierarchy ({exc})'}), flush=True)
        except Exception:
            pass
        hierarchy_df = None

    if hierarchy_df is not None and hasattr(hierarchy_df, 'columns'):
        try:
            print(json.dumps({'type': 'hierarchy_columns', 'columns': [str(c) for c in hierarchy_df.columns]}), flush=True)
        except Exception:
            pass

    topics_payload, hierarchy_stats = build_topic_tree(
        topic_model=topic_model,
        topic_info=topic_info,
        hierarchy_df=hierarchy_df,
        topics=topics,
        probabilities=probs,
        doc_ids=doc_ids,
        top_terms=params.get('top_n_terms', 10),
        hierarchy_conf=hierarchy_params,
    )

    # Emit diagnostic metadata so the app can show useful errors instead of silently flattening
    parents_expected = int(hierarchy_stats.get('parents_expected', 0) or 0)
    parents_emitted = int(hierarchy_stats.get('parents_emitted', 0) or 0)
    debug_payload = {
        'type': 'hierarchy_debug',
        'parents_expected': parents_expected,
        'parents_emitted': parents_emitted,
        'total_topics': len(topics_payload),
        'roots': int(hierarchy_stats.get('roots', 0) or 0),
        'leaf_count': int(hierarchy_stats.get('leaf_count', 0) or 0),
        'max_level': int(hierarchy_stats.get('max_level', 0) or 0),
    }
    print(json.dumps(debug_payload), flush=True)

    if hasattr(topics, 'shape'):
        try:
            outlier_count = int((topics == -1).sum())
        except Exception:
            outlier_count = sum(1 for item in topics if _to_int(item) == -1)
    else:
        outlier_count = sum(1 for item in topics if _to_int(item) == -1)

    out_payload = {
        'topics': topics_payload,
        'meta': {
            'nr_topics': int(topic_model.get_params().get('nr_topics') or len(topics_payload)),
            'outliers': int(outlier_count),
            'parents_expected': parents_expected,
            'parents_emitted': parents_emitted,
            'max_level': int(hierarchy_stats.get('max_level', 0) or 0),
        },
    }
    print(json.dumps(out_payload), flush=True)


if __name__ == '__main__':
    main()
