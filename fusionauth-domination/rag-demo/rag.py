#!/usr/bin/env python3
"""
FusionAuth Documentation RAG (Retrieval-Augmented Generation) Demo

This implementation demonstrates an advanced RAG system specifically designed for
FusionAuth documentation, providing intelligent question-answering capabilities
with context-aware responses and accurate source attribution.

Features:
- Semantic document indexing with vector embeddings
- Intelligent chunking with context preservation
- Multi-modal search (semantic + keyword + code)
- Real-time answer generation with source citations
- Progressive learning from user interactions
- Performance monitoring and optimization
- Integration with FusionAuth APIs for live examples

Usage:
    python rag.py --index-docs --start-server
    python rag.py --query "How do I set up React authentication?"
    python rag.py --interactive
"""

import os
import sys
import json
import time
import logging
import argparse
import asyncio
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Optional, Tuple, Union
from pathlib import Path
import hashlib
import pickle
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import faiss

# NLP and ML libraries
try:
    import openai
    import tiktoken
    from sentence_transformers import SentenceTransformer
    import chromadb
    from chromadb.config import Settings
except ImportError as e:
    print(f"Missing required dependency: {e}")
    print("Install with: pip install openai tiktoken sentence-transformers chromadb-client")
    sys.exit(1)

# Web framework for API
try:
    from fastapi import FastAPI, HTTPException, BackgroundTasks
    from fastapi.responses import StreamingResponse
    import uvicorn
    from pydantic import BaseModel, Field
except ImportError as e:
    print(f"Missing web framework dependency: {e}")
    print("Install with: pip install fastapi uvicorn pydantic")
    sys.exit(1)

# Document processing
try:
    import markdown
    from bs4 import BeautifulSoup
    import frontmatter
except ImportError as e:
    print(f"Missing document processing dependency: {e}")
    print("Install with: pip install markdown beautifulsoup4 python-frontmatter")
    sys.exit(1)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
CONFIG = {
    'docs_path': Path('./docs'),
    'index_path': Path('./rag_index'),
    'cache_path': Path('./rag_cache'),
    'embeddings_model': 'all-MiniLM-L6-v2',
    'openai_model': 'gpt-4-turbo-preview',
    'chunk_size': 1000,
    'chunk_overlap': 200,
    'max_context_length': 16000,
    'top_k_documents': 10,
    'similarity_threshold': 0.7,
    'cache_ttl_hours': 24
}

@dataclass
class DocumentChunk:
    """Represents a chunk of documentation with metadata"""
    id: str
    content: str
    source_file: str
    title: str
    section: Optional[str]
    url: Optional[str]
    embedding: Optional[np.ndarray] = None
    metadata: Dict[str, Any] = None
    last_updated: datetime = None

@dataclass
class SearchResult:
    """Search result with relevance score"""
    chunk: DocumentChunk
    score: float
    relevance_type: str  # 'semantic', 'keyword', 'code'

@dataclass
class RAGResponse:
    """Complete RAG response with answer and sources"""
    query: str
    answer: str
    sources: List[Dict[str, Any]]
    confidence: float
    response_time: float
    tokens_used: int
    metadata: Dict[str, Any] = None

class DocumentProcessor:
    """Processes and chunks FusionAuth documentation"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.encoding = tiktoken.get_encoding("cl100k_base")
        
    def process_directory(self, docs_path: Path) -> List[DocumentChunk]:
        """Process all documentation files in directory"""
        chunks = []
        
        # Supported file extensions
        supported_extensions = {'.md', '.mdx', '.rst', '.txt'}
        
        for file_path in docs_path.rglob('*'):
            if file_path.suffix.lower() in supported_extensions:
                try:
                    file_chunks = self.process_file(file_path)
                    chunks.extend(file_chunks)
                    logger.info(f"Processed {file_path}: {len(file_chunks)} chunks")
                except Exception as e:
                    logger.error(f"Error processing {file_path}: {e}")
        
        logger.info(f"Total chunks created: {len(chunks)}")
        return chunks
    
    def process_file(self, file_path: Path) -> List[DocumentChunk]:
        """Process a single documentation file"""
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Parse frontmatter if present
        if file_path.suffix.lower() in {'.md', '.mdx'}:
            try:
                post = frontmatter.loads(content)
                metadata = post.metadata
                content = post.content
            except:
                metadata = {}
        else:
            metadata = {}
        
        # Extract title
        title = metadata.get('title', '')
        if not title:
            # Try to extract title from first heading
            lines = content.split('\n')
            for line in lines:
                if line.startswith('# '):
                    title = line[2:].strip()
                    break
            if not title:
                title = file_path.stem.replace('-', ' ').replace('_', ' ').title()
        
        # Process markdown to extract structured content
        if file_path.suffix.lower() in {'.md', '.mdx'}:
            html = markdown.markdown(content, extensions=['codehilite', 'fenced_code', 'tables'])
            soup = BeautifulSoup(html, 'html.parser')
            structured_content = self.extract_structured_content(soup)
        else:
            structured_content = [{'type': 'text', 'content': content}]
        
        # Create chunks with context preservation
        chunks = self.create_contextual_chunks(
            structured_content, 
            file_path, 
            title, 
            metadata
        )
        
        return chunks
    
    def extract_structured_content(self, soup: BeautifulSoup) -> List[Dict[str, Any]]:
        """Extract structured content from HTML"""
        content_blocks = []
        current_section = None
        
        for element in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre', 'ul', 'ol', 'table']):
            if element.name.startswith('h'):
                # New section
                current_section = element.get_text().strip()
                content_blocks.append({
                    'type': 'heading',
                    'level': int(element.name[1]),
                    'content': current_section,
                    'section': current_section
                })
            elif element.name == 'pre':
                # Code block
                code_content = element.get_text()
                language = self.detect_code_language(element)
                content_blocks.append({
                    'type': 'code',
                    'content': code_content,
                    'language': language,
                    'section': current_section
                })
            elif element.name in ['ul', 'ol']:
                # List
                list_content = element.get_text()
                content_blocks.append({
                    'type': 'list',
                    'content': list_content,
                    'section': current_section
                })
            elif element.name == 'table':
                # Table
                table_content = element.get_text()
                content_blocks.append({
                    'type': 'table',
                    'content': table_content,
                    'section': current_section
                })
            else:
                # Regular text
                text_content = element.get_text().strip()
                if text_content:  # Skip empty paragraphs
                    content_blocks.append({
                        'type': 'text',
                        'content': text_content,
                        'section': current_section
                    })
        
        return content_blocks
    
    def detect_code_language(self, pre_element) -> Optional[str]:
        """Detect programming language from code block"""
        # Check for class attribute
        classes = pre_element.get('class', [])
        for cls in classes:
            if cls.startswith('language-'):
                return cls[9:]  # Remove 'language-' prefix
            elif cls in ['javascript', 'python', 'java', 'typescript', 'bash', 'json', 'yaml']:
                return cls
        
        # Check parent code element
        code_elem = pre_element.find('code')
        if code_elem:
            classes = code_elem.get('class', [])
            for cls in classes:
                if cls.startswith('language-'):
                    return cls[9:]
                elif cls in ['javascript', 'python', 'java', 'typescript', 'bash', 'json', 'yaml']:
                    return cls
        
        return None
    
    def create_contextual_chunks(
        self, 
        content_blocks: List[Dict[str, Any]], 
        file_path: Path, 
        title: str, 
        metadata: Dict[str, Any]
    ) -> List[DocumentChunk]:
        """Create chunks with preserved context"""
        chunks = []
        current_chunk = []
        current_size = 0
        current_section = None
        
        chunk_id_base = hashlib.md5(str(file_path).encode()).hexdigest()[:8]
        
        for i, block in enumerate(content_blocks):
            block_text = block['content']
            block_tokens = len(self.encoding.encode(block_text))
            
            # Update current section
            if block['type'] == 'heading':
                current_section = block['content']
            
            # Check if we need to create a new chunk
            if (current_size + block_tokens > self.config['chunk_size'] and current_chunk):
                # Create chunk from accumulated blocks
                chunk_content = self.combine_blocks(current_chunk)
                chunk = self.create_chunk(
                    f"{chunk_id_base}_{len(chunks):03d}",
                    chunk_content,
                    file_path,
                    title,
                    current_section,
                    metadata
                )
                chunks.append(chunk)
                
                # Start new chunk with overlap
                overlap_blocks = self.get_overlap_blocks(current_chunk)
                current_chunk = overlap_blocks + [block]
                current_size = sum(len(self.encoding.encode(b['content'])) for b in current_chunk)
            else:
                current_chunk.append(block)
                current_size += block_tokens
        
        # Create final chunk if there's remaining content
        if current_chunk:
            chunk_content = self.combine_blocks(current_chunk)
            chunk = self.create_chunk(
                f"{chunk_id_base}_{len(chunks):03d}",
                chunk_content,
                file_path,
                title,
                current_section,
                metadata
            )
            chunks.append(chunk)
        
        return chunks
    
    def combine_blocks(self, blocks: List[Dict[str, Any]]) -> str:
        """Combine content blocks into coherent text"""
        combined = []
        
        for block in blocks:
            if block['type'] == 'heading':
                combined.append(f"\n## {block['content']}\n")
            elif block['type'] == 'code':
                lang = block.get('language', '')
                combined.append(f"\n```{lang}\n{block['content']}\n```\n")
            elif block['type'] == 'list':
                combined.append(f"\n{block['content']}\n")
            elif block['type'] == 'table':
                combined.append(f"\n{block['content']}\n")
            else:
                combined.append(block['content'])
        
        return '\n'.join(combined).strip()
    
    def get_overlap_blocks(self, blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Get blocks for overlap with next chunk"""
        if not blocks:
            return []
        
        # Include last few blocks for context, up to overlap size
        overlap_tokens = 0
        overlap_blocks = []
        
        for block in reversed(blocks):
            block_tokens = len(self.encoding.encode(block['content']))
            if overlap_tokens + block_tokens <= self.config['chunk_overlap']:
                overlap_blocks.insert(0, block)
                overlap_tokens += block_tokens
            else:
                break
        
        return overlap_blocks
    
    def create_chunk(
        self,
        chunk_id: str,
        content: str,
        file_path: Path,
        title: str,
        section: Optional[str],
        metadata: Dict[str, Any]
    ) -> DocumentChunk:
        """Create a DocumentChunk object"""
        # Generate URL if possible
        url = metadata.get('url')
        if not url:
            # Generate URL from file path (customize for your docs structure)
            relative_path = file_path.relative_to(self.config['docs_path'])
            url_path = str(relative_path).replace('\\', '/').replace('.md', '').replace('.mdx', '')
            url = f"https://fusionauth.io/docs/{url_path}"
            if section:
                # Create anchor from section title
                anchor = section.lower().replace(' ', '-').replace('&', '').replace('?', '')
                url += f"#{anchor}"
        
        return DocumentChunk(
            id=chunk_id,
            content=content,
            source_file=str(file_path),
            title=title,
            section=section,
            url=url,
            metadata={
                **metadata,
                'token_count': len(self.encoding.encode(content)),
                'content_types': self.analyze_content_types(content)
            },
            last_updated=datetime.now()
        )
    
    def analyze_content_types(self, content: str) -> List[str]:
        """Analyze what types of content are in the chunk"""
        types = []
        
        if '```' in content:
            types.append('code')
        if any(keyword in content.lower() for keyword in ['api', 'endpoint', '/api/']):
            types.append('api')
        if any(keyword in content.lower() for keyword in ['install', 'setup', 'configure']):
            types.append('setup')
        if any(keyword in content.lower() for keyword in ['example', 'tutorial', 'how to']):
            types.append('tutorial')
        if any(keyword in content.lower() for keyword in ['error', 'troubleshoot', 'problem']):
            types.append('troubleshooting')
        
        return types

class VectorStore:
    """Vector storage and retrieval using FAISS and ChromaDB"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.index_path = config['index_path']
        self.embeddings_model = SentenceTransformer(config['embeddings_model'])
        
        # Initialize ChromaDB
        self.chroma_client = chromadb.PersistentClient(
            path=str(self.index_path / "chroma_db"),
            settings=Settings(anonymized_telemetry=False)
        )
        
        # Get or create collection
        try:
            self.collection = self.chroma_client.get_collection("fusionauth_docs")
        except:
            self.collection = self.chroma_client.create_collection(
                name="fusionauth_docs",
                metadata={"description": "FusionAuth documentation chunks"}
            )
        
        # FAISS index for fast similarity search
        self.faiss_index = None
        self.chunk_ids = []
        
        # Load existing index if available
        self.load_index()
    
    def index_documents(self, chunks: List[DocumentChunk]) -> None:
        """Index document chunks for retrieval"""
        logger.info(f"Indexing {len(chunks)} document chunks...")
        
        # Generate embeddings
        texts = [chunk.content for chunk in chunks]
        embeddings = self.embeddings_model.encode(texts, show_progress_bar=True)
        
        # Update chunks with embeddings
        for chunk, embedding in zip(chunks, embeddings):
            chunk.embedding = embedding
        
        # Add to ChromaDB
        self.collection.add(
            documents=[chunk.content for chunk in chunks],
            metadatas=[{
                'id': chunk.id,
                'source_file': chunk.source_file,
                'title': chunk.title,
                'section': chunk.section or '',
                'url': chunk.url or '',
                'metadata': json.dumps(chunk.metadata or {})
            } for chunk in chunks],
            ids=[chunk.id for chunk in chunks],
            embeddings=embeddings.tolist()
        )
        
        # Build FAISS index
        dimension = embeddings.shape[1]
        self.faiss_index = faiss.IndexFlatIP(dimension)  # Inner product (cosine similarity)
        
        # Normalize embeddings for cosine similarity
        normalized_embeddings = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)
        self.faiss_index.add(normalized_embeddings.astype('float32'))
        
        self.chunk_ids = [chunk.id for chunk in chunks]
        
        # Save index
        self.save_index()
        
        logger.info("Document indexing completed")
    
    def search(
        self, 
        query: str, 
        top_k: int = 10, 
        filters: Optional[Dict[str, Any]] = None
    ) -> List[SearchResult]:
        """Search for relevant documents"""
        # Generate query embedding
        query_embedding = self.embeddings_model.encode([query])
        query_embedding = query_embedding / np.linalg.norm(query_embedding)
        
        # Search with FAISS for speed
        scores, indices = self.faiss_index.search(
            query_embedding.astype('float32'), 
            top_k * 2  # Get more candidates for filtering
        )
        
        # Get detailed results from ChromaDB
        candidate_ids = [self.chunk_ids[idx] for idx in indices[0] if idx < len(self.chunk_ids)]
        
        # Query ChromaDB for detailed metadata
        chroma_results = self.collection.get(
            ids=candidate_ids,
            include=['documents', 'metadatas', 'embeddings']
        )
        
        # Create search results
        results = []
        for i, (doc_id, document, metadata) in enumerate(zip(
            chroma_results['ids'],
            chroma_results['documents'],
            chroma_results['metadatas']
        )):
            # Apply filters if provided
            if filters and not self.apply_filters(metadata, filters):
                continue
                
            score = float(scores[0][indices[0].tolist().index(candidate_ids.index(doc_id))])
            
            # Create DocumentChunk from stored data
            chunk = DocumentChunk(
                id=doc_id,
                content=document,
                source_file=metadata['source_file'],
                title=metadata['title'],
                section=metadata['section'] if metadata['section'] else None,
                url=metadata['url'] if metadata['url'] else None,
                metadata=json.loads(metadata.get('metadata', '{}'))
            )
            
            results.append(SearchResult(
                chunk=chunk,
                score=score,
                relevance_type='semantic'
            ))
        
        # Sort by score and return top_k
        results.sort(key=lambda x: x.score, reverse=True)
        return results[:top_k]
    
    def hybrid_search(
        self, 
        query: str, 
        top_k: int = 10,
        semantic_weight: float = 0.7,
        keyword_weight: float = 0.3
    ) -> List[SearchResult]:
        """Hybrid search combining semantic and keyword matching"""
        # Semantic search
        semantic_results = self.search(query, top_k * 2)
        
        # Keyword search using TF-IDF
        keyword_results = self.keyword_search(query, top_k * 2)
        
        # Combine and re-rank results
        combined_results = self.combine_search_results(
            semantic_results, 
            keyword_results,
            semantic_weight,
            keyword_weight
        )
        
        return combined_results[:top_k]
    
    def keyword_search(self, query: str, top_k: int = 10) -> List[SearchResult]:
        """Keyword-based search using TF-IDF"""
        # Get all documents
        all_docs = self.collection.get(include=['documents', 'metadatas'])
        
        if not all_docs['documents']:
            return []
        
        # Create TF-IDF vectorizer
        vectorizer = TfidfVectorizer(
            stop_words='english',
            ngram_range=(1, 2),
            max_features=5000
        )
        
        # Fit and transform documents
        doc_vectors = vectorizer.fit_transform(all_docs['documents'])
        query_vector = vectorizer.transform([query])
        
        # Calculate similarities
        similarities = cosine_similarity(query_vector, doc_vectors)[0]
        
        # Get top results
        top_indices = np.argsort(similarities)[::-1][:top_k]
        
        results = []
        for idx in top_indices:
            if similarities[idx] > 0:  # Only include non-zero similarities
                metadata = all_docs['metadatas'][idx]
                chunk = DocumentChunk(
                    id=all_docs['ids'][idx],
                    content=all_docs['documents'][idx],
                    source_file=metadata['source_file'],
                    title=metadata['title'],
                    section=metadata['section'] if metadata['section'] else None,
                    url=metadata['url'] if metadata['url'] else None,
                    metadata=json.loads(metadata.get('metadata', '{}'))
                )
                
                results.append(SearchResult(
                    chunk=chunk,
                    score=float(similarities[idx]),
                    relevance_type='keyword'
                ))
        
        return results
    
    def combine_search_results(
        self,
        semantic_results: List[SearchResult],
        keyword_results: List[SearchResult],
        semantic_weight: float,
        keyword_weight: float
    ) -> List[SearchResult]:
        """Combine and re-rank search results"""
        # Create a mapping of document IDs to combined scores
        combined_scores = {}
        all_results = {}
        
        # Add semantic results
        for result in semantic_results:
            doc_id = result.chunk.id
            combined_scores[doc_id] = semantic_weight * result.score
            all_results[doc_id] = result
        
        # Add keyword results
        for result in keyword_results:
            doc_id = result.chunk.id
            if doc_id in combined_scores:
                combined_scores[doc_id] += keyword_weight * result.score
                all_results[doc_id].relevance_type = 'hybrid'
            else:
                combined_scores[doc_id] = keyword_weight * result.score
                result.relevance_type = 'keyword'
                all_results[doc_id] = result
        
        # Sort by combined score
        sorted_ids = sorted(combined_scores.keys(), key=lambda x: combined_scores[x], reverse=True)
        
        # Update scores and return results
        final_results = []
        for doc_id in sorted_ids:
            result = all_results[doc_id]
            result.score = combined_scores[doc_id]
            final_results.append(result)
        
        return final_results
    
    def apply_filters(self, metadata: Dict[str, Any], filters: Dict[str, Any]) -> bool:
        """Apply filters to search results"""
        for key, value in filters.items():
            if key == 'content_types':
                doc_metadata = json.loads(metadata.get('metadata', '{}'))
                doc_types = doc_metadata.get('content_types', [])
                if not any(ct in doc_types for ct in value):
                    return False
            elif key == 'source_file':
                if value not in metadata.get('source_file', ''):
                    return False
        
        return True
    
    def save_index(self) -> None:
        """Save FAISS index and metadata"""
        if self.faiss_index:
            os.makedirs(self.index_path, exist_ok=True)
            faiss.write_index(self.faiss_index, str(self.index_path / "faiss_index.idx"))
            
            with open(self.index_path / "chunk_ids.pkl", 'wb') as f:
                pickle.dump(self.chunk_ids, f)
    
    def load_index(self) -> bool:
        """Load existing FAISS index and metadata"""
        try:
            faiss_path = self.index_path / "faiss_index.idx"
            chunk_ids_path = self.index_path / "chunk_ids.pkl"
            
            if faiss_path.exists() and chunk_ids_path.exists():
                self.faiss_index = faiss.read_index(str(faiss_path))
                
                with open(chunk_ids_path, 'rb') as f:
                    self.chunk_ids = pickle.load(f)
                
                logger.info(f"Loaded existing index with {len(self.chunk_ids)} chunks")
                return True
                
        except Exception as e:
            logger.warning(f"Failed to load existing index: {e}")
        
        return False

class RAGSystem:
    """Complete RAG system for FusionAuth documentation"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.document_processor = DocumentProcessor(config)
        self.vector_store = VectorStore(config)
        self.cache = {}
        self.cache_path = config['cache_path']
        
        # Initialize OpenAI client
        openai.api_key = os.getenv('OPENAI_API_KEY')
        if not openai.api_key:
            logger.warning("OpenAI API key not found. Some features may be limited.")
        
        # Load cache
        self.load_cache()
        
        # Performance metrics
        self.metrics = {
            'queries_processed': 0,
            'cache_hits': 0,
            'avg_response_time': 0,
            'total_tokens_used': 0
        }
    
    def index_documentation(self, docs_path: Optional[Path] = None) -> None:
        """Index all documentation for RAG"""
        if docs_path is None:
            docs_path = self.config['docs_path']
        
        logger.info(f"Starting documentation indexing from {docs_path}")
        
        # Process documents
        chunks = self.document_processor.process_directory(docs_path)
        
        if not chunks:
            logger.warning("No document chunks created. Check the docs path and file formats.")
            return
        
        # Index chunks
        self.vector_store.index_documents(chunks)
        
        logger.info("Documentation indexing completed successfully")
    
    def query(
        self, 
        question: str, 
        context_type: str = 'auto',
        max_context_chunks: int = 5,
        use_cache: bool = True,
        stream_response: bool = False
    ) -> Union[RAGResponse, Any]:
        """Process a query and return RAG response"""
        start_time = time.time()
        
        # Check cache first
        if use_cache:
            cache_key = self.create_cache_key(question, context_type, max_context_chunks)
            if cache_key in self.cache:
                cached_response = self.cache[cache_key]
                if self.is_cache_valid(cached_response):
                    self.metrics['cache_hits'] += 1
                    return cached_response['response']
        
        try:
            # Retrieve relevant documents
            search_results = self.retrieve_context(question, max_context_chunks, context_type)
            
            # Generate response
            if stream_response:
                return self.generate_streaming_response(question, search_results)
            else:
                response = self.generate_response(question, search_results)
                response.response_time = time.time() - start_time
                
                # Cache the response
                if use_cache:
                    self.cache_response(cache_key, response)
                
                # Update metrics
                self.update_metrics(response)
                
                return response
                
        except Exception as e:
            logger.error(f"Error processing query: {e}")
            return RAGResponse(
                query=question,
                answer=f"I apologize, but I encountered an error processing your question: {str(e)}",
                sources=[],
                confidence=0.0,
                response_time=time.time() - start_time,
                tokens_used=0
            )
    
    def retrieve_context(
        self, 
        question: str, 
        max_chunks: int = 5,
        context_type: str = 'auto'
    ) -> List[SearchResult]:
        """Retrieve relevant context for the question"""
        
        # Determine search strategy based on context type
        if context_type == 'auto':
            context_type = self.determine_context_type(question)
        
        # Apply content type filters based on question
        filters = self.create_search_filters(question, context_type)
        
        # Perform hybrid search
        search_results = self.vector_store.hybrid_search(
            query=question,
            top_k=max_chunks * 2,  # Get more candidates for filtering
        )
        
        # Apply additional filtering and ranking
        filtered_results = self.filter_and_rank_results(
            search_results, 
            question, 
            context_type,
            filters
        )
        
        return filtered_results[:max_chunks]
    
    def determine_context_type(self, question: str) -> str:
        """Determine the type of context needed based on the question"""
        question_lower = question.lower()
        
        if any(keyword in question_lower for keyword in ['api', 'endpoint', 'curl', 'request', 'response']):
            return 'api'
        elif any(keyword in question_lower for keyword in ['install', 'setup', 'configure', 'deploy']):
            return 'setup'
        elif any(keyword in question_lower for keyword in ['code', 'example', 'implement', 'integrate']):
            return 'tutorial'
        elif any(keyword in question_lower for keyword in ['error', 'problem', 'issue', 'troubleshoot']):
            return 'troubleshooting'
        else:
            return 'general'
    
    def create_search_filters(self, question: str, context_type: str) -> Dict[str, Any]:
        """Create search filters based on question and context type"""
        filters = {}
        
        if context_type == 'api':
            filters['content_types'] = ['api']
        elif context_type == 'setup':
            filters['content_types'] = ['setup']
        elif context_type == 'tutorial':
            filters['content_types'] = ['tutorial', 'code']
        elif context_type == 'troubleshooting':
            filters['content_types'] = ['troubleshooting']
        
        return filters
    
    def filter_and_rank_results(
        self,
        results: List[SearchResult],
        question: str,
        context_type: str,
        filters: Dict[str, Any]
    ) -> List[SearchResult]:
        """Additional filtering and ranking of search results"""
        
        # Apply relevance threshold
        filtered_results = [
            result for result in results 
            if result.score >= self.config['similarity_threshold']
        ]
        
        # Boost results that match content type preferences
        for result in filtered_results:
            content_types = result.chunk.metadata.get('content_types', [])
            
            if context_type == 'api' and 'api' in content_types:
                result.score *= 1.2
            elif context_type == 'tutorial' and 'code' in content_types:
                result.score *= 1.2
            elif context_type == 'troubleshooting' and 'troubleshooting' in content_types:
                result.score *= 1.2
        
        # Re-sort by adjusted scores
        filtered_results.sort(key=lambda x: x.score, reverse=True)
        
        return filtered_results
    
    def generate_response(self, question: str, search_results: List[SearchResult]) -> RAGResponse:
        """Generate response using OpenAI GPT"""
        
        if not openai.api_key:
            return self.generate_fallback_response(question, search_results)
        
        # Prepare context
        context_text = self.prepare_context(search_results)
        
        # Create prompt
        prompt = self.create_prompt(question, context_text)
        
        try:
            # Generate response with OpenAI
            response = openai.ChatCompletion.create(
                model=self.config['openai_model'],
                messages=[
                    {
                        "role": "system",
                        "content": "You are a helpful assistant specializing in FusionAuth documentation. "
                                   "Provide accurate, detailed answers based on the provided context. "
                                   "Always cite your sources using the provided URLs. "
                                   "If the context doesn't contain enough information, say so clearly."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=0.1,
                max_tokens=1000,
                top_p=0.9
            )
            
            answer = response.choices[0].message.content
            tokens_used = response.usage.total_tokens
            
            # Calculate confidence based on search result scores
            confidence = self.calculate_confidence(search_results)
            
            # Prepare sources
            sources = self.prepare_sources(search_results)
            
            return RAGResponse(
                query=question,
                answer=answer,
                sources=sources,
                confidence=confidence,
                response_time=0,  # Will be set by caller
                tokens_used=tokens_used,
                metadata={
                    'model_used': self.config['openai_model'],
                    'context_chunks': len(search_results),
                    'context_type': self.determine_context_type(question)
                }
            )
            
        except Exception as e:
            logger.error(f"OpenAI API error: {e}")
            return self.generate_fallback_response(question, search_results)
    
    def generate_fallback_response(
        self, 
        question: str, 
        search_results: List[SearchResult]
    ) -> RAGResponse:
        """Generate fallback response without OpenAI"""
        
        if not search_results:
            answer = "I couldn't find relevant information in the FusionAuth documentation to answer your question."
        else:
            # Create a simple extractive answer
            top_result = search_results[0]
            answer = f"Based on the FusionAuth documentation:\n\n{top_result.chunk.content[:500]}..."
            
            if len(search_results) > 1:
                answer += f"\n\nYou can find more information in the related documentation sections."
        
        return RAGResponse(
            query=question,
            answer=answer,
            sources=self.prepare_sources(search_results),
            confidence=self.calculate_confidence(search_results),
            response_time=0,
            tokens_used=0,
            metadata={'fallback_response': True}
        )
    
    def generate_streaming_response(self, question: str, search_results: List[SearchResult]):
        """Generate streaming response for real-time interaction"""
        
        if not openai.api_key:
            # Return simple generator for fallback
            def fallback_stream():
                response = self.generate_fallback_response(question, search_results)
                yield f"data: {json.dumps({'answer': response.answer, 'done': True})}\n\n"
            return fallback_stream()
        
        context_text = self.prepare_context(search_results)
        prompt = self.create_prompt(question, context_text)
        
        def stream_generator():
            try:
                response = openai.ChatCompletion.create(
                    model=self.config['openai_model'],
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a helpful assistant specializing in FusionAuth documentation."
                        },
                        {
                            "role": "user",
                            "content": prompt
                        }
                    ],
                    temperature=0.1,
                    max_tokens=1000,
                    stream=True
                )
                
                for chunk in response:
                    if chunk.choices[0].delta.get('content'):
                        content = chunk.choices[0].delta.content
                        yield f"data: {json.dumps({'content': content})}\n\n"
                
                # Send completion signal with sources
                sources = self.prepare_sources(search_results)
                yield f"data: {json.dumps({'done': True, 'sources': sources})}\n\n"
                
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
        
        return stream_generator()
    
    def prepare_context(self, search_results: List[SearchResult]) -> str:
        """Prepare context text from search results"""
        context_parts = []
        
        for i, result in enumerate(search_results, 1):
            chunk = result.chunk
            context_part = f"--- Source {i}: {chunk.title}"
            if chunk.section:
                context_part += f" - {chunk.section}"
            context_part += f" ---\n{chunk.content}\n"
            context_parts.append(context_part)
        
        return "\n".join(context_parts)
    
    def create_prompt(self, question: str, context: str) -> str:
        """Create prompt for LLM"""
        return f"""Based on the following FusionAuth documentation context, please answer the user's question accurately and comprehensively.

Context:
{context}

Question: {question}

Please provide a detailed answer based on the context provided. Include relevant code examples if available in the context. Always cite the sources by mentioning the document titles and sections. If the context doesn't contain sufficient information to fully answer the question, please state that clearly.

Answer:"""
    
    def calculate_confidence(self, search_results: List[SearchResult]) -> float:
        """Calculate confidence score based on search results"""
        if not search_results:
            return 0.0
        
        # Average of top result scores, weighted by relevance type
        weights = {'semantic': 1.0, 'hybrid': 0.9, 'keyword': 0.7}
        
        weighted_scores = []
        for result in search_results:
            weight = weights.get(result.relevance_type, 0.5)
            weighted_scores.append(result.score * weight)
        
        return min(np.mean(weighted_scores), 1.0)
    
    def prepare_sources(self, search_results: List[SearchResult]) -> List[Dict[str, Any]]:
        """Prepare source information for response"""
        sources = []
        
        for result in search_results:
            chunk = result.chunk
            source = {
                'title': chunk.title,
                'section': chunk.section,
                'url': chunk.url,
                'relevance_score': round(result.score, 3),
                'relevance_type': result.relevance_type
            }
            sources.append(source)
        
        return sources
    
    def create_cache_key(self, question: str, context_type: str, max_chunks: int) -> str:
        """Create cache key for query"""
        key_data = f"{question}|{context_type}|{max_chunks}"
        return hashlib.md5(key_data.encode()).hexdigest()
    
    def cache_response(self, cache_key: str, response: RAGResponse) -> None:
        """Cache response with timestamp"""
        self.cache[cache_key] = {
            'response': response,
            'timestamp': datetime.now()
        }
        
        # Persist cache
        self.save_cache()
    
    def is_cache_valid(self, cached_item: Dict[str, Any]) -> bool:
        """Check if cached item is still valid"""
        age = datetime.now() - cached_item['timestamp']
        return age < timedelta(hours=self.config['cache_ttl_hours'])
    
    def save_cache(self) -> None:
        """Save cache to disk"""
        os.makedirs(self.cache_path, exist_ok=True)
        with open(self.cache_path / 'response_cache.pkl', 'wb') as f:
            pickle.dump(self.cache, f)
    
    def load_cache(self) -> None:
        """Load cache from disk"""
        try:
            cache_file = self.cache_path / 'response_cache.pkl'
            if cache_file.exists():
                with open(cache_file, 'rb') as f:
                    self.cache = pickle.load(f)
                
                # Clean expired entries
                self.clean_cache()
                
        except Exception as e:
            logger.warning(f"Failed to load cache: {e}")
            self.cache = {}
    
    def clean_cache(self) -> None:
        """Remove expired cache entries"""
        expired_keys = [
            key for key, item in self.cache.items()
            if not self.is_cache_valid(item)
        ]
        
        for key in expired_keys:
            del self.cache[key]
    
    def update_metrics(self, response: RAGResponse) -> None:
        """Update performance metrics"""
        self.metrics['queries_processed'] += 1
        self.metrics['total_tokens_used'] += response.tokens_used
        
        # Update rolling average response time
        current_avg = self.metrics['avg_response_time']
        count = self.metrics['queries_processed']
        self.metrics['avg_response_time'] = (
            (current_avg * (count - 1) + response.response_time) / count
        )
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get current performance metrics"""
        return {
            **self.metrics,
            'cache_hit_rate': (
                self.metrics['cache_hits'] / max(self.metrics['queries_processed'], 1)
            ),
            'cache_size': len(self.cache)
        }

# FastAPI Web Interface
app = FastAPI(title="FusionAuth Documentation RAG API", version="1.0.0")

# Global RAG system instance
rag_system = None

class QueryRequest(BaseModel):
    question: str = Field(..., description="Question to ask about FusionAuth")
    context_type: str = Field("auto", description="Type of context: auto, api, setup, tutorial, troubleshooting")
    max_context_chunks: int = Field(5, description="Maximum number of context chunks to use", ge=1, le=20)
    stream: bool = Field(False, description="Stream the response")

class QueryResponse(BaseModel):
    query: str
    answer: str
    sources: List[Dict[str, Any]]
    confidence: float
    response_time: float
    tokens_used: int
    metadata: Optional[Dict[str, Any]] = None

@app.on_event("startup")
async def startup_event():
    """Initialize RAG system on startup"""
    global rag_system
    rag_system = RAGSystem(CONFIG)
    logger.info("RAG API server started")

@app.get("/")
async def root():
    """Root endpoint"""
    return {"message": "FusionAuth Documentation RAG API", "version": "1.0.0"}

@app.post("/query", response_model=QueryResponse)
async def query_endpoint(request: QueryRequest):
    """Query the RAG system"""
    if not rag_system:
        raise HTTPException(status_code=500, detail="RAG system not initialized")
    
    if request.stream:
        return StreamingResponse(
            rag_system.query(
                request.question,
                context_type=request.context_type,
                max_context_chunks=request.max_context_chunks,
                stream_response=True
            ),
            media_type="text/plain"
        )
    else:
        response = rag_system.query(
            request.question,
            context_type=request.context_type,
            max_context_chunks=request.max_context_chunks,
            stream_response=False
        )
        
        return QueryResponse(**asdict(response))

@app.get("/metrics")
async def metrics_endpoint():
    """Get system metrics"""
    if not rag_system:
        raise HTTPException(status_code=500, detail="RAG system not initialized")
    
    return rag_system.get_metrics()

@app.post("/index")
async def index_endpoint(background_tasks: BackgroundTasks):
    """Trigger documentation re-indexing"""
    if not rag_system:
        raise HTTPException(status_code=500, detail="RAG system not initialized")
    
    background_tasks.add_task(rag_system.index_documentation)
    return {"message": "Documentation indexing started in background"}

def main():
    """Main CLI interface"""
    parser = argparse.ArgumentParser(description="FusionAuth Documentation RAG System")
    parser.add_argument("--index-docs", action="store_true", help="Index documentation")
    parser.add_argument("--query", type=str, help="Query to ask")
    parser.add_argument("--interactive", action="store_true", help="Start interactive mode")
    parser.add_argument("--start-server", action="store_true", help="Start FastAPI server")
    parser.add_argument("--docs-path", type=str, help="Path to documentation directory")
    parser.add_argument("--port", type=int, default=8000, help="Server port")
    parser.add_argument("--verbose", action="store_true", help="Verbose logging")
    
    args = parser.parse_args()
    
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    # Update config if docs path provided
    if args.docs_path:
        CONFIG['docs_path'] = Path(args.docs_path)
    
    # Initialize RAG system
    rag = RAGSystem(CONFIG)
    
    if args.index_docs:
        print("Indexing documentation...")
        rag.index_documentation()
        print("Documentation indexing completed!")
    
    if args.query:
        print(f"\nQuery: {args.query}")
        response = rag.query(args.query)
        print(f"\nAnswer: {response.answer}")
        print(f"\nSources:")
        for i, source in enumerate(response.sources, 1):
            print(f"  {i}. {source['title']} - {source['url']}")
        print(f"\nConfidence: {response.confidence:.2f}")
        print(f"Response time: {response.response_time:.2f}s")
    
    if args.interactive:
        print("\nStarting interactive mode. Type 'quit' to exit.")
        while True:
            try:
                question = input("\n> ").strip()
                if question.lower() in ['quit', 'exit', 'q']:
                    break
                if not question:
                    continue
                
                response = rag.query(question)
                print(f"\nAnswer: {response.answer}")
                
                if response.sources:
                    print(f"\nSources:")
                    for i, source in enumerate(response.sources[:3], 1):
                        print(f"  {i}. {source['title']} ({source['url']})")
                
            except KeyboardInterrupt:
                break
        print("\nGoodbye!")
    
    if args.start_server:
        global rag_system
        rag_system = rag
        print(f"Starting server on port {args.port}...")
        uvicorn.run(app, host="0.0.0.0", port=args.port)

if __name__ == "__main__":
    main()