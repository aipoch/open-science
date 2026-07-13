#!/usr/bin/env python3
"""
PubMed Search Specialist
Builds complex Boolean query strings for precise PubMed/MEDLINE retrieval.
"""

import argparse
import json
import re
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, asdict
from enum import Enum


class FieldTag(Enum):
    """PubMed field tags for search queries."""
    MESH_TERMS = "[MeSH Terms]"
    MESH_MAJOR = "[MeSH Major Topic]"
    TITLE = "[Title]"
    ABSTRACT = "[Abstract]"
    TITLE_ABSTRACT = "[Title/Abstract]"
    AUTHOR = "[Author]"
    JOURNAL = "[Journal]"
    PUB_DATE = "[Publication Date]"
    LANGUAGE = "[Language]"
    PUB_TYPE = "[Publication Type]"
    AFFILIATION = "[Affiliation]"


class FilterType(Enum):
    """Common PubMed filter categories."""
    HUMANS = 'humans[MeSH Terms]'
    ANIMALS = 'animals[MeSH Terms]'
    ENGLISH = 'english[Language]'
    ADULT = 'adult[MeSH Terms]'
    AGED = 'aged[MeSH Terms]'
    CHILD = 'child[MeSH Terms]'
    LAST_5_YEARS = f'{(2024-5)}:2024[Publication Date]'
    LAST_10_YEARS = f'{(2024-10)}:2024[Publication Date]'
    RCT = 'randomized controlled trial[Publication Type]'
    META_ANALYSIS = 'meta-analysis[Publication Type]'
    SYSTEMATIC_REVIEW = 'systematic review[Publication Type]'
    REVIEW = 'review[Publication Type]'
    CLINICAL_TRIAL = 'clinical trial[Publication Type]'


@dataclass
class SearchConcept:
    """Represents a search concept with MeSH and text word components."""
    name: str
    mesh_terms: List[str]
    text_words: List[str]
    use_explode: bool = True
    subheadings: Optional[List[str]] = None
    
    def to_query(self) -> str:
        """Convert concept to query string."""
        parts = []
        
        # Add MeSH terms
        for mesh in self.mesh_terms:
            if self.subheadings:
                for sub in self.subheadings:
                    parts.append(f'"{mesh}/{sub}"{FieldTag.MESH_TERMS.value}')
            else:
                explode_mod = "" if self.use_explode else ":noexp"
                parts.append(f'"{mesh}"{FieldTag.MESH_TERMS.value}{explode_mod}')
        
        # Add text words
        for tw in self.text_words:
            parts.append(f'"{tw}"{FieldTag.TITLE_ABSTRACT.value}')
        
        return f"({(' OR '.join(parts))})"


@dataclass
class SearchStrategy:
    """Complete search strategy with concepts and filters."""
    concepts: List[SearchConcept]
    filters: List[str]
    description: str = ""
    
    def to_query(self) -> str:
        """Build complete Boolean query."""
        concept_queries = [c.to_query() for c in self.concepts]
        all_parts = concept_queries + self.filters
        return f"({' AND '.join(all_parts)})"
    
    def to_line_by_line(self) -> str:
        """Generate line-by-line search strategy."""
        lines = []
        for i, concept in enumerate(self.concepts, 1):
            lines.append(f"# {i}. {concept.name}")
            lines.append(concept.to_query())
        
        if self.filters:
            lines.append(f"# {len(self.concepts) + 1}. Filters")
            lines.append(f"({' AND '.join(self.filters)})")
        
        lines.append("\n# Final Query")
        lines.append(self.to_query())
        
        return '\n'.join(lines)


class MeSHMapper:
    """Maps common medical concepts to MeSH terms."""
    
    # Common term mappings (simplified - production would use MeSH API)
    COMMON_MESH = {
        # Populations
        "diabetes": ["Diabetes Mellitus", "Diabetes Mellitus, Type 2", "Diabetes Mellitus, Type 1"],
        "hypertension": ["Hypertension"],
        "obesity": ["Obesity"],
        "stroke": ["Stroke", "Brain Ischemia"],
        "myocardial infarction": ["Myocardial Infarction"],
        "heart failure": ["Heart Failure"],
        "cancer": ["Neoplasms"],
        "depression": ["Depression"],
        "alzheimer": ["Alzheimer Disease"],
        "asthma": ["Asthma"],
        "copd": ["Pulmonary Disease, Chronic Obstructive"],
        
        # Interventions
        "aspirin": ["Aspirin"],
        "metformin": ["Metformin"],
        "insulin": ["Insulin"],
        "statins": ["Hydroxymethylglutaryl-CoA Reductase Inhibitors"],
        "placebo": ["Placebos"],
        "surgery": ["Surgical Procedures, Operative"],
        "exercise": ["Exercise"],
        "diet": ["Diet Therapy"],
        
        # Outcomes
        "mortality": ["Mortality"],
        "quality of life": ["Quality of Life"],
        "adverse effects": ["Drug-Related Side Effects and Adverse Reactions"],
        "efficacy": ["Treatment Outcome"],
        "safety": ["Safety"],
    }
    
    @classmethod
    def suggest_mesh(cls, concept: str) -> List[str]:
        """Suggest MeSH terms for a concept."""
        concept_lower = concept.lower()
        results = []
        
        for key, terms in cls.COMMON_MESH.items():
            if key in concept_lower or concept_lower in key:
                results.extend(terms)
        
        return list(set(results)) if results else [concept]
    
    @classmethod
    def suggest_synonyms(cls, concept: str) -> List[str]:
        """Suggest text word synonyms for a concept."""
        # Simplified synonym mapping
        synonyms = {
            "diabetes": ["diabetic", "diabetics", "hyperglycemia"],
            "hypertension": ["high blood pressure", "elevated blood pressure"],
            "stroke": ["cerebrovascular accident", "cva", "brain attack"],
            "myocardial infarction": ["heart attack", "mi", "cardiac infarction"],
            "aspirin": ["acetylsalicylic acid", "asa"],
            "children": ["child", "pediatric", "paediatric", "infant", "adolescent"],
            "elderly": ["aged", "older adults", "geriatric", "seniors"],
        }
        
        concept_lower = concept.lower()
        for key, syns in synonyms.items():
            if key in concept_lower or concept_lower in key:
                return syns
        
        return []


class QueryBuilder:
    """Builds PubMed Boolean queries."""
    
    CLINICAL_QUERIES = {
        "therapy": """(
            randomized controlled trial[Publication Type] OR 
            (randomized[Title/Abstract] AND controlled[Title/Abstract] AND trial[Title/Abstract]) OR
            (clinical[Title/Abstract] AND trial[Title/Abstract])
        )""",
        
        "diagnosis": """(
            sensitivity and specificity[MeSH Terms] OR 
            sensitivity[Title/Abstract] OR 
            specificity[Title/Abstract] OR 
            "diagnostic accuracy"[Title/Abstract] OR
            "likelihood ratio"[Title/Abstract] OR
            "roc curve"[Title/Abstract]
        )""",
        
        "prognosis": """(
            incidence[MeSH Terms] OR 
            mortality[MeSH Terms] OR 
            "follow-up studies"[MeSH Terms] OR 
            prognos*[Title/Abstract] OR 
            predict*[Title/Abstract] OR
            course[Title/Abstract]
        )""",
        
        "etiology": """(
            risk[MeSH Terms] OR 
            "risk factors"[MeSH Terms] OR 
            (risk[Title/Abstract] AND factor*[Title/Abstract]) OR
            caus*[Title/Abstract] OR
            associat*[Title/Abstract]
        )""",
        
        "clinical_prediction": """(
            "predictive value of tests"[MeSH Terms] OR
            "clinical prediction rule"[Title/Abstract] OR
            (predict*[Title/Abstract] AND model[Title/Abstract]) OR
            "decision rule"[Title/Abstract] OR
            "risk score"[Title/Abstract]
        )"""
    }
    
    @classmethod
    def build_pico_query(
        cls,
        population: Optional[str] = None,
        intervention: Optional[str] = None,
        comparison: Optional[str] = None,
        outcome: Optional[str] = None,
        study_type: Optional[str] = None
    ) -> SearchStrategy:
        """Build query from PICO components."""
        concepts = []
        
        if population:
            mesh_terms = MeSHMapper.suggest_mesh(population)
            synonyms = MeSHMapper.suggest_synonyms(population)
            concepts.append(SearchConcept(
                name="Population",
                mesh_terms=mesh_terms,
                text_words=synonyms + [population],
                use_explode=True
            ))
        
        if intervention:
            mesh_terms = MeSHMapper.suggest_mesh(intervention)
            synonyms = MeSHMapper.suggest_synonyms(intervention)
            concepts.append(SearchConcept(
                name="Intervention",
                mesh_terms=mesh_terms,
                text_words=synonyms + [intervention],
                use_explode=True
            ))
        
        if comparison:
            mesh_terms = MeSHMapper.suggest_mesh(comparison)
            synonyms = MeSHMapper.suggest_synonyms(comparison)
            concepts.append(SearchConcept(
                name="Comparison",
                mesh_terms=mesh_terms,
                text_words=synonyms + [comparison],
                use_explode=True
            ))
        
        if outcome:
            mesh_terms = MeSHMapper.suggest_mesh(outcome)
            synonyms = MeSHMapper.suggest_synonyms(outcome)
            concepts.append(SearchConcept(
                name="Outcome",
                mesh_terms=mesh_terms,
                text_words=synonyms + [outcome],
                use_explode=True
            ))
        
        filters = []
        if study_type and study_type.lower() in cls.CLINICAL_QUERIES:
            filters.append(cls.CLINICAL_QUERIES[study_type.lower()])
        
        return SearchStrategy(
            concepts=concepts,
            filters=filters,
            description="PICO-based search strategy"
        )
    
    @classmethod
    def validate_query(cls, query: str) -> Tuple[bool, List[str]]:
        """Validate query syntax."""
        errors = []
        
        # Check balanced parentheses
        if query.count('(') != query.count(')'):
            errors.append("Unbalanced parentheses")
        
        # Check for unclosed quotes
        if query.count('"') % 2 != 0:
            errors.append("Unclosed quotation marks")
        
        # Check for valid field tags
        valid_tags = [tag.value for tag in FieldTag]
        # Extract potential field tags
        found_tags = re.findall(r'\[[A-Za-z/ ]+\]', query)
        for tag in found_tags:
            if tag not in valid_tags:
                errors.append(f"Unusual field tag: {tag}")
        
        return len(errors) == 0, errors


def main():
    parser = argparse.ArgumentParser(
        description="PubMed Search Specialist - Build complex Boolean queries"
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Available commands')
    
    # PICO command
    pico_parser = subparsers.add_parser('pico', help='Build query from PICO framework')
    pico_parser.add_argument('-p', '--population', help='Population/Problem')
    pico_parser.add_argument('-i', '--intervention', help='Intervention')
    pico_parser.add_argument('-c', '--comparison', help='Comparison')
    pico_parser.add_argument('-o', '--outcome', help='Outcome')
    pico_parser.add_argument('-s', '--study-type', 
                           choices=['therapy', 'diagnosis', 'prognosis', 'etiology', 'clinical_prediction'],
                           help='Clinical query category')
    pico_parser.add_argument('--format', choices=['query', 'lines', 'json'], default='lines',
                           help='Output format')
    
    # MeSH suggestion command
    mesh_parser = subparsers.add_parser('mesh', help='Suggest MeSH terms')
    mesh_parser.add_argument('concept', help='Concept to map')
    
    # Validate command
    validate_parser = subparsers.add_parser('validate', help='Validate query syntax')
    validate_parser.add_argument('query', help='Query string to validate')
    
    args = parser.parse_args()
    
    if args.command == 'pico':
        strategy = QueryBuilder.build_pico_query(
            population=args.population,
            intervention=args.intervention,
            comparison=args.comparison,
            outcome=args.outcome,
            study_type=args.study_type
        )
        
        if args.format == 'json':
            print(json.dumps(asdict(strategy), indent=2, default=str))
        elif args.format == 'query':
            print(strategy.to_query())
        else:  # lines
            print(strategy.to_line_by_line())
    
    elif args.command == 'mesh':
        mesh_terms = MeSHMapper.suggest_mesh(args.concept)
        synonyms = MeSHMapper.suggest_synonyms(args.concept)
        
        print(f"Concept: {args.concept}")
        print(f"\nSuggested MeSH Terms:")
        for term in mesh_terms:
            print(f"  - {term}")
        print(f"\nSuggested Text Words:")
        for syn in synonyms:
            print(f"  - {syn}")
    
    elif args.command == 'validate':
        valid, errors = QueryBuilder.validate_query(args.query)
        if valid:
            print("✓ Query syntax is valid")
        else:
            print("✗ Query has errors:")
            for error in errors:
                print(f"  - {error}")
    
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
