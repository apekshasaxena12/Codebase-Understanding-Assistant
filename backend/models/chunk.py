"""
Database models — defines what gets stored in PostgreSQL + pgvector
"""
from sqlalchemy import Column, String, Text, Integer, JSON
from sqlalchemy.dialects.postgresql import UUID
from pgvector.sqlalchemy import Vector
from database import Base
import uuid


class CodeChunk(Base):
    __tablename__ = "code_chunks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    start_line = Column(Integer)
    end_line = Column(Integer)
    embedding = Column(Vector(384))


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
    """
    Stores one edge of the dependency graph: source file imports target.
    """
    __tablename__ = "file_dependencies"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(String, nullable=False, index=True)
    source = Column(String, nullable=False)   # file that imports
    target = Column(String, nullable=False)   # file being imported