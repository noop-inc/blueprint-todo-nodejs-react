import { useState, useRef, useEffect } from 'react'
import logo from './logo.svg'
import { fetchAllTodos, createTodo, updateTodo, deleteTodo } from './api.js'
import { handleFormatImages, handleBodyOverflow } from './utils.js'

const App = () => {
  const [mounted, setMounted] = useState(false)
  const [todos, setTodos] = useState([])
  const [createForm, setCreateForm] = useState(false)
  const [formDescription, setFormDescription] = useState(null)
  const [formImages, setFormImages] = useState([])
  const imageInput = useRef(null)
  const [invalidDescription, setInvalidDescription] = useState(false)
  const [invalidImageCount, setInvalidImageCount] = useState(false)
  const [enlargedImage, setEnlargedImage] = useState(null)
  const [editId, setEditId] = useState(null)

  const assignImages = () => {
    const {
      nextImageCount,
      nextImages
    } = handleFormatImages(imageInput.current.files, formImages)
    setInvalidImageCount(nextImageCount)
    setFormImages(nextImages)
    imageInput.current.value = null
  }

  const removeImage = (e, idx) => {
    e.preventDefault()
    setInvalidImageCount(false)
    setFormImages(formImages => formImages.filter((_, i) => i !== idx))
  }

  const clearForm = () => {
    setFormDescription(null)
    setFormImages([])
    setInvalidDescription(false)
    setInvalidImageCount(false)
  }

  const closeModal = () => {
    handleCreateForm(false)
    setEnlargedImage(false)
  }

  const handleCreateForm = state => {
    setCreateForm(state)
    clearForm()
  }

  const editToggle = (e, id) => {
    e.stopPropagation()
    e.preventDefault()
    const currentTodo = todos.find(todo => todo.id === id)
    const input = window.document.getElementById(`edit-description-${id}`)
    input.value = currentTodo.description
    setEditId(id)
    window.setTimeout(() => {
      input.focus()
    }, 0)
  }

  const handleFetchAllTodos = async () => {
    const allTodo = await fetchAllTodos()
    setTodos(allTodo.sort((a, b) => a.created - b.created))
  }

  const handleUpdateTodo = async (e, item) => {
    e?.preventDefault()
    const updatedTodo = await updateTodo(item)
    setTodos(todos => todos.map(todo => todo.id === updatedTodo.id ? updatedTodo : todo))
  }

  const handleDeleteTodo = async (e, id) => {
    e.preventDefault()
    const deletedTodo = await deleteTodo(id)
    setTodos(todos => todos.filter(todo => todo.id !== deletedTodo.id))
  }

  const handleSubmit = async e => {
    e.preventDefault()
    if (!formDescription?.trim()) {
      setInvalidDescription(true)
    } else {
      const newTodo = await createTodo(formDescription, formImages)
      setTodos(todos => [...todos, newTodo])
      handleCreateForm(() => false)
    }
  }

  const handleEdit = async e => {
    e.preventDefault()
    const currentTodo = todos.find(todo => todo.id === editId)
    const input = window.document.getElementById(`edit-description-${currentTodo.id}`)
    const value = input.value?.trim()
    if (value) {
      if (value !== currentTodo.description) {
        await handleUpdateTodo(null, { id: currentTodo.id, description: value })
      }
      setEditId(null)
    }
  }

  const handleEnlargedImage = (e, key) => {
    e.preventDefault()
    setEnlargedImage(key)
  }

  useEffect(() => {
    if (!mounted) {
      (async () => {
        await handleFetchAllTodos()
      })()
      setMounted(true)
    } else {
      handleBodyOverflow(createForm, enlargedImage)
      if (invalidDescription && formDescription) {
        setInvalidDescription(false)
      }
    }

    const handleEscape = e => {
      if (e.key === 'Escape') closeModal()
    }

    window.document.addEventListener('keyup', handleEscape)

    return () => {
      window.document.removeEventListener('keyup', handleEscape)
    }
  })

  return (
    <>
      <header className='todo-header'>
        <h1>
          <a
            className='form-link'
            href='https://noop.dev'
            target='_blank' rel='noreferrer'
          >
            <img
              alt='Noop'
              src={logo}
            />
          </a>
          <span>Todo Application</span>
          <button
            className='form-button'
            title='New Todo'
            onClick={() => handleCreateForm(true)}
          >
            New Todo
          </button>
        </h1>
      </header>
      {
        !!todos.length &&
          <section className='todo-list'>
            {
              todos.map(({ description, images, id, completed }) =>
                <div
                  key={id}
                  className='todo-item'
                >
                  <div className='todo-description'>
                    <button
                      type='button'
                      className={`form-button todo-complete${completed ? ' completed' : ''}`}
                      title='Toggle Complete'
                      onClick={e => handleUpdateTodo(e, { id, completed: !completed })}
                    >
                      <span>✓</span>
                    </button>
                    <button
                      type='button'
                      className='form-button todo-delete'
                      title='Delete'
                      onClick={e => handleDeleteTodo(e, id)}
                    >
                      <span>×</span>
                    </button>
                    <div
                      className={completed ? 'completed' : ''}
                      onDoubleClick={e => editToggle(e, id)}
                    >
                      <form
                        className={`edit-form${editId !== id ? ' display-none' : ''}`}
                        onSubmit={e => handleEdit(e)}
                        onClick={e => e.stopPropagation()}
                      >
                        <input
                          id={`edit-description-${id}`}
                          placeholder='What needs to be completed?'
                          className='form-input edit-description'
                          type='text'
                          autoComplete='off'
                          onBlur={() => setEditId(null)}
                        />
                        <input
                          type='submit'
                          className='display-none'
                        />
                      </form>
                      <span className={editId === id ? 'display-none' : ''}>{description}</span>
                    </div>
                  </div>
                  {
                    images && !!images?.length &&
                      <div
                        className='image-preview-grid'
                      >
                        {
                          images.map(key =>
                            <span
                              key={key}
                              className='image-preview-item'
                            >
                              <img src={`/api/images/${key}`} />
                              <button
                                type='button'
                                className='form-button image-preview-button'
                                title='Enlarge Image'
                                onClick={e => handleEnlargedImage(e, key)}
                              />
                            </span>
                          )
                        }
                      </div>
                  }
                </div>
              )
            }
          </section>
      }
      {
        !!(enlargedImage || createForm) &&
          <section
            className='todo-modal'
            onClick={() => closeModal()}
          >
            {
              !!enlargedImage &&
                <div
                  className='enlarged-image'
                  onClick={e => e.stopPropagation()}
                >
                  <img src={`/api/images/${enlargedImage}`} />
                </div>
            }
            {
              !!createForm &&
                <form
                  className='todo-form'
                  onSubmit={e => handleSubmit(e)}
                  onClick={e => e.stopPropagation()}
                >
                  <div className='todo-form-row'>
                    <h5 className='todo-form-header'>
                      <button
                        className='form-button todo-close'
                        title='Close modal'
                        type='button'
                        onClick={() => closeModal()}
                      >
                        ×
                      </button>
                      <span>Provide Todo Details…</span>
                    </h5>
                  </div>
                  <hr className='divider' />

                  <div className='todo-form-row'>
                    <label htmlFor='form-description'>
                      Description (required)
                    </label>
                    <input
                      id='form-description'
                      onInput={e => setFormDescription(e.target.value)}
                      className='form-input'
                      type='text'
                      autoComplete='off'
                      placeholder='What needs to be completed?'
                    />
                    {
                      !!invalidDescription &&
                        <label
                          className='form-error'
                        >
                          Todo description is required
                        </label>
                    }
                  </div>
                  <div className='todo-form-row'>
                    <label htmlFor='form-file'>
                      Attach up to 6 images (optional)
                    </label>
                    <input
                      id='form-file'
                      ref={imageInput}
                      className='form-input'
                      type='file'
                      multiple
                      accept='image/*'
                      onInput={() => assignImages()}
                    />
                    {
                      !!invalidImageCount &&
                        <label
                          className='form-error'
                        >
                          Maximum of 6 images can be attached
                        </label>
                    }
                    {
                      !!formImages.length &&
                        <div
                          className='image-preview-grid'
                        >
                          {
                            formImages.map(({ src, key }, idx) =>
                              <span
                                key={key}
                                className='image-preview-item'
                              >
                                <img src={src} />
                                <button
                                  type='button'
                                  className='form-button image-preview-button'
                                  title='Remove Image'
                                  onClick={e => removeImage(e, idx)}
                                >
                                  <span>
                                    ×
                                  </span>
                                </button>
                              </span>
                            )
                          }
                        </div>
                    }
                  </div>
                  <hr className='divider' />
                  <div className='todo-form-row'>
                    <button
                      id='form-submit'
                      className='form-button'
                      type='submit'
                      title='Create Todo'
                    >
                      Create Todo
                    </button>
                  </div>
                </form>
            }
          </section>
      }
    </>
  )
}

export default App
