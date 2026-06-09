"""
Database models — defines what gets stored in PostgreSQL + pgvector
"""
from sqlalchemy import Column, String, Text, Integer, JSON, Index
from sqlalchemy.dialects.postgresql import UUID
from pgvector.sqlalchemy import Vector
from database import Base
import uuid


class CodeChunk(Base):
    __tablename__ = "code_chunks"
    __table_args__ = (
        # HNSW index for sub-millisecond cosine similarity (requires pgvector >= 0.5)
        Index(
            "ix_code_chunks_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
            postgresql_with={"m": 16, "ef_construction": 64},
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(String, nullable=False, index=True)
    file_path = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    start_line = Column(Integer)
    end_line = Column(Integer)
    embedding = Column(Vector(1024))


class FileSymbol(Base):
    __tablename__ = "file_symbols"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(String, nullable=False, index=True)
    file_path = Column(String, nullable=False)
    functions = Column(JSON, default=list)
    classes = Column(JSON, default=list)
    imports = Column(JSON, default=list)
    top_level_docstring = Column(Text, nullable=True)


class FileDependency(Base):
    """Stores one edge of the dependency graph: source file imports target."""
    __tablename__ = "file_dependencies"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(String, nullable=False, index=True)
    source = Column(String, nullable=False)
    target = Column(String, nullable=False)


class CallEdge(Base):
    """Precomputed function-to-function call graph edges (computed once at ingest time)."""
    __tablename__ = "call_edges"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(String, nullable=False, index=True)
    caller_id = Column(String, nullable=False)   # e.g. "fn::filename.py::func_name"
    callee_id = Column(String, nullable=False)   # e.g. "fn::filename.py::func_name"
